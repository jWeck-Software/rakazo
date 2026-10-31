import type { AgentImportFile, GrokBotFile, GrokRecipe } from "@rakazo/contracts";
import {
  AGENT_IMPORT_MAX_FILE_LENGTH,
  AGENT_IMPORT_MAX_FILES,
  AGENT_IMPORT_MAX_TOTAL_LENGTH,
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  GrokBotFileSchema,
} from "@rakazo/contracts";
import { buildSkillMd, parseSkillMd } from "../agent-skill.js";
import type { AgentImportParse, SkillFiles } from "./shared.js";
import { byPath, instructionItem, isSkillPath, memoryItem, skillItems } from "./shared.js";

/*
 * Grok Bot templates, from Cursor's recipe or from a template folder. The folder layout, the
 * slug rules and Cursor's request shapes follow pi-grokbot-import (MIT, Shixuuu,
 * https://github.com/Shixuuu/pi-grokbot-import), which converts the grokbot-pi-templates
 * catalog. Importing by link follows OpenMausBot (Apache-2.0, milind-soni,
 * https://github.com/milind-soni/OpenMausBot).
 */

/** One Grok Bot template, whichever way it arrived. */
export type GrokBot = Omit<GrokBotFile, "skills"> & {
  skills: { name: string; description: string; body: string }[];
};
type GrokRoutine = GrokBotFile["routines"][number];
type GrokTemplate = NonNullable<GrokBot["template"]>;

/** What the template route sends: the bot, with its skills as SKILL.md files beside it. */
export const GROK_BOT_FILE = "grok-bot.json";
/** The folder converter writes it, and so can any Pi project. */
export const GROK_FOLDER_SIGNATURE = ".pi/APPEND_SYSTEM.md";
const FOLDER_FILES = new Set([GROK_FOLDER_SIGNATURE, "README.md", "CONNECTORS.md"]);
const ROUTINE_FILE = /^routines\/([^/]+)\.md$/;
const SHARE_ID = /^[A-Za-z0-9_-]{21}$/;

/** By link: `grok-bot.json` and its skills. As a folder: the converter's files. */
export type GrokTemplateKind = "link" | "folder";

/** Read only from that kind of template; skills, AGENTS.md and MEMORY.md are read from any folder. */
export function isGrokTemplateFile(path: string, kind: GrokTemplateKind): boolean {
  return kind === "link"
    ? path === GROK_BOT_FILE
    : FOLDER_FILES.has(path) || ROUTINE_FILE.test(path);
}

/** The id in `https://x.ai/bot/<id>` (www, a trailing slash or a query allowed) or `grokbot://app/v1/bot-template?id=<id>`. */
export function grokShareId(link: string): string | null {
  const raw = link.trim();
  let url: URL;
  try {
    url = new URL(/^(?:www\.)?x\.ai\//i.test(raw) ? `https://${raw}` : raw);
  } catch {
    return null;
  }
  const id =
    url.protocol === "grokbot:"
      ? url.hostname === "app" && url.pathname === "/v1/bot-template"
        ? url.searchParams.get("id")
        : null
      : url.protocol === "https:" &&
          (url.hostname === "x.ai" || url.hostname === "www.x.ai") &&
          !url.port &&
          !url.username &&
          !url.password
        ? /^\/bot\/([^/]+)\/?$/.exec(url.pathname)?.[1]
        : null;
  return id && SHARE_ID.test(id) ? id : null;
}

export const grokShareUrl = (shareId: string) => `https://x.ai/bot/${shareId}`;

const TRIGGERS = "Fires on:";
const SETUP = "Ask the importing user for:";
/** The importing user's own time zone replaces a `CRON_TZ=` the template kept. */
const CRON_TRIGGER = /^- cron `(?:CRON_TZ=\S+\s+)?([^`]+)`$/;

/** A routine's text ends with what it fires on; the prompt is the text before those lists. */
function routineText(text: string): Pick<GrokRoutine, "prompt" | "crons" | "otherTriggers"> {
  const prompt: string[] = [];
  const crons: string[] = [];
  let otherTriggers = false;
  let list: string | null = null;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === TRIGGERS || trimmed === SETUP) {
      list = trimmed;
      continue;
    }
    if (list && (trimmed === "" || trimmed.startsWith("- "))) {
      const cron = CRON_TRIGGER.exec(trimmed)?.[1]?.trim();
      if (list === TRIGGERS && trimmed && !cron) otherTriggers = true;
      // The trigger list can repeat a schedule, once with the creator's zone.
      if (list === TRIGGERS && cron && !crons.includes(cron)) crons.push(cron);
      continue;
    }
    list = null;
    prompt.push(line);
  }
  return { prompt: prompt.join("\n").trim(), crons, otherTriggers };
}

/** pi-grokbot-import's `toSkillSlug`, so a template's link and folder name skills alike. */
function slugOf(name: string, used: Set<string>, fallback: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-")
      .slice(0, 64) || fallback;
  let slug = base;
  for (let n = 2; used.has(slug); n += 1) slug = `${base}-${n}`.slice(0, 64);
  used.add(slug);
  return slug;
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function grokBotFromRecipe(recipe: GrokRecipe, template: GrokTemplate): GrokBot {
  const usedSkills = new Set<string>();
  const skills = recipe.skills.map((skill) => {
    // Most skills carry their own frontmatter; its name wins, as in the folder converter.
    const fence = /^﻿?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(skill.content);
    const own = fence ? parseSkillMd(skill.content) : null;
    const parsed = own && !("error" in own) ? own : null;
    const original = parsed?.name || skill.name.trim() || "skill";
    const body = (fence ? skill.content.slice(fence[0].length) : skill.content).trim();
    return {
      original,
      name: slugOf(original, usedSkills, "unnamed-skill"),
      description: oneLine(parsed?.description || skill.description || original, 1_024),
      body: `${body}\n`,
    };
  });
  const starter = recipe.gettingStarted?.skill;
  const usedRoutines = new Set<string>();
  const memory = recipe.memory.flatMap((entry) => {
    const content = entry.content.trim();
    return content ? [{ profile: entry.kind === "profile", content }] : [];
  });
  return {
    name: recipe.profile.name.trim() || template.name,
    title: recipe.profile.title.trim(),
    description: recipe.profile.description.trim(),
    profile: memory.filter((entry) => entry.profile).map((entry) => entry.content),
    notes: memory.filter((entry) => !entry.profile).map((entry) => entry.content),
    skills: skills.map(({ name, description, body }) => ({ name, description, body })),
    routines: recipe.routines.map((routine) => {
      const slug = slugOf(routine.slug || routine.name, usedRoutines, "routine");
      return { name: routine.name.trim() || slug, slug, ...routineText(routine.content) };
    }),
    connectors: recipe.plugins.flatMap((plugin) =>
      plugin.name.trim() ? [{ name: plugin.name.trim(), description: plugin.description }] : [],
    ),
    gettingStarted: starter
      ? (skills.find(
          (skill) => skill.original === starter || skill.name === slugOf(starter, new Set(), ""),
        )?.name ?? null)
      : null,
    template,
  };
}

/**
 * `grok-bot.json` and one SKILL.md per skill, within the import's limits. A skill left out
 * stays listed in `grok-bot.json`, so the preview shows it as not imported.
 */
export function grokBotFiles(bot: GrokBot): AgentImportFile[] {
  const listing: GrokBotFile = {
    ...bot,
    skills: bot.skills.map(({ name, description }) => ({ name, description })),
  };
  const files: AgentImportFile[] = [{ path: GROK_BOT_FILE, content: JSON.stringify(listing) }];
  let total = files[0]!.content.length;
  for (const skill of bot.skills) {
    const content = buildSkillMd(skill);
    if (content.length > AGENT_IMPORT_MAX_FILE_LENGTH) continue;
    if (files.length >= AGENT_IMPORT_MAX_FILES) break;
    if (total + content.length > AGENT_IMPORT_MAX_TOTAL_LENGTH) continue;
    total += content.length;
    files.push({ path: `skills/${skill.name}/SKILL.md`, content });
  }
  return files;
}

/** The template in an upload: `grok-bot.json`, or a template folder. */
export function readGrokBot(files: ReadonlyMap<string, string>): GrokBotFile | null {
  const json = files.get(GROK_BOT_FILE);
  if (json === undefined) return grokBotFromFolder(files);
  try {
    const parsed = GrokBotFileSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const lines = (text: string) => text.replace(/\r\n?/g, "\n").split("\n");

/**
 * The converter's AGENTS.md: `# Name`, `**Title:** …`, the description and its own pointers,
 * then lists of what is imported separately, from `## Skills` on. Standing instructions are
 * MEMORY.md's `profile` entries; the rest of MEMORY.md is notes.
 */
function grokBotFromFolder(files: ReadonlyMap<string, string>): GrokBotFile {
  const agents = lines(files.get("AGENTS.md") ?? "");
  const end = agents.findIndex((line) => /^##\s+(?:Skills|Running in Pi)\b/.test(line.trim()));
  const head = agents.slice(0, end >= 0 ? end : agents.length);
  const name = head.map((line) => /^#\s+(.+)$/.exec(line.trim())?.[1]).find(Boolean) ?? "";
  const title = head.map((line) => /^\*\*Title:\*\*\s*(.+)$/.exec(line.trim())?.[1]).find(Boolean);
  const starter = head.map((line) => /follow the `([^`]+)` skill/.exec(line)?.[1]).find(Boolean);
  const description = head
    .filter((line) => {
      const trimmed = line.trim();
      return !(
        /^#\s/.test(trimmed) ||
        trimmed.startsWith("**Title:**") ||
        trimmed.startsWith("On first run (or when the user is new)") ||
        trimmed.startsWith("Seed memories (rules and facts from the template)") ||
        trimmed === "_(The template has no profile description.)_"
      );
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const memory = folderMemory(files.get("MEMORY.md") ?? "");
  return {
    name,
    title: title?.trim() ?? "",
    description,
    profile: memory.filter((entry) => entry.kind === "profile").map((entry) => entry.content),
    notes: memory.filter((entry) => entry.kind !== "profile").map((entry) => entry.content),
    skills: [...files]
      .filter(([path]) => isSkillPath(path))
      .flatMap(([, content]) => {
        const parsed = parseSkillMd(content);
        return "error" in parsed ? [] : [{ name: parsed.name, description: parsed.description }];
      }),
    routines: [...files.keys()].sort().flatMap((path) => {
      const slug = ROUTINE_FILE.exec(path)?.[1];
      if (!slug) return [];
      const [first = "", ...rest] = lines(files.get(path) ?? "");
      const heading = /^#\s+Routine:\s*(.+)$/.exec(first.trim());
      const body = heading ? rest : [first, ...rest];
      // The `> summary` under the title describes the routine to people, not to the bot.
      const start = body.findIndex((line) => line.trim());
      if (start >= 0 && body[start]!.trim().startsWith(">")) body.splice(start, 1);
      return [{ name: heading?.[1]?.trim() || slug, slug, ...routineText(body.join("\n")) }];
    }),
    connectors: lines(files.get("CONNECTORS.md") ?? "").flatMap((line) => {
      const cells = /^\|(.*)\|$/
        .exec(line.trim())?.[1]
        ?.split(/(?<!\\)\|/)
        .map((cell) => cell.trim().replace(/\\\|/g, "|"));
      const [cell = "", , description = ""] = cells ?? [];
      return cell && cell !== "Plugin" && !/^:?-+:?$/.test(cell)
        ? [{ name: cell, description }]
        : [];
    }),
    gettingStarted: starter ?? null,
    template: folderTemplate(files.get("README.md") ?? "", name),
  };
}

/** `- **profile** (2026-07-09): text`, continued on lines indented by two spaces. */
function folderMemory(markdown: string): { kind: string; content: string }[] {
  const entries: { kind: string; content: string[] }[] = [];
  for (const line of lines(markdown)) {
    const entry = /^- \*\*([^*]+)\*\*(?: \([^)]*\))?:\s?(.*)$/.exec(line);
    if (entry) entries.push({ kind: entry[1]!.trim(), content: [entry[2]!] });
    else if (line.startsWith("  ") && entries.length) entries.at(-1)!.content.push(line.slice(2));
  }
  return entries.flatMap(({ kind, content }) => {
    const text = content.join("\n").trim();
    return text ? [{ kind, content: text }] : [];
  });
}

/** README.md's `Original template` and `Creator` rows; `unknown` names no one. */
function folderTemplate(readme: string, fallbackName: string): GrokTemplate | null {
  const row = (label: string) =>
    new RegExp(`^\\|\\s*${label}\\s*\\|\\s*(.+?)\\s*\\|\\s*$`, "m").exec(readme)?.[1] ?? "";
  const url = row("Original template");
  if (!/^https:\/\/\S+$/.test(url)) return null;
  const by = row("Creator");
  const linked = /^(.*?)\s*\(\[@([^\]]+)\]\([^)]*\)\)$/.exec(by);
  const who = (linked?.[1] ?? by).trim();
  const named = who === "unknown" ? "" : who;
  const handle = linked?.[2]?.trim();
  return {
    url,
    name: /^#\s+(.+)$/m.exec(readme)?.[1]?.trim() || fallbackName,
    creator: (handle ? (named ? `${named} (@${handle})` : `@${handle}`) : named) || null,
  };
}

/** The bot's persona with its credit, its notes as memory, and its skills from SKILL.md files. */
export function grokPlan(
  bot: GrokBotFile,
  files: ReadonlyMap<string, string>,
  skillFiles: SkillFiles = {},
): AgentImportParse {
  const skills = skillItems(new Map(files), skillFiles);
  const sent = new Set(skills.skills.map((skill) => skill.name));
  const template = bot.template;
  const credit = template
    ? `Based on the Grok Bot template ${template.url ? `[${template.name}](${template.url})` : template.name}${template.creator ? ` by ${template.creator}` : ""}.`
    : "";
  const persona = [
    bot.title && bot.title.toLowerCase() !== bot.name.toLowerCase()
      ? `**Title:** ${bot.title}`
      : "",
    bot.description,
    ...bot.profile,
    bot.gettingStarted ? `When the user is new, start with the ${bot.gettingStarted} skill.` : "",
    credit,
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
  const notes = bot.notes.map((note) => `- ${note.replace(/\n/g, "\n  ")}`).join("\n");
  return {
    suggestedName: (bot.name || template?.name || "Grok Bot").slice(0, BOT_NAME_MAX_LENGTH),
    suggestedDescription: bot.description.slice(0, BOT_DESCRIPTION_MAX_LENGTH),
    instructions: persona
      ? [instructionItem("AGENTS.md", `${persona}\n`, { role: "persona" })]
      : [],
    memory: notes ? [memoryItem("MEMORY.md", "MEMORY.md", "MEMORY.md", `${notes}\n`)] : [],
    skills: skills.skills,
    skipped: [
      // A Grok plugin carries nothing an MCP server could be made from.
      ...bot.connectors.map((connector) => ({
        path: `CONNECTORS.md: ${connector.name}`,
        reason: "unsupported" as const,
      })),
      // Too large to send.
      ...bot.skills
        .filter((skill) => !sent.has(skill.name))
        .map((skill) => ({
          path: `skills/${skill.name}/SKILL.md`,
          reason: "invalid_skill" as const,
        })),
      ...skills.skipped,
    ].sort(byPath),
  };
}
