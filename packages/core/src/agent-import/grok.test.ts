import type { AgentImportFile, AgentImportPlan, GrokRecipe } from "@rakazo/contracts";
import { GrokRecipeSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { parseSkillMd } from "../agent-skill.js";
import {
  agentImportUpload,
  chooseAgentImportFiles,
  grokBotFiles,
  grokBotFromRecipe,
  grokShareId,
  parseAgentImport,
} from "./index.js";

const SHARE_ID = "AAAAAAAAAAAAAAAAAAAA1";
const SHARE_URL = `https://x.ai/bot/${SHARE_ID}`;
const DESCRIPTION = "Plans dock slots for an invented shipping yard.";

const morningCheck = [
  "Check the slot board and list any clashes.",
  "",
  "Fires on:",
  "- cron `CRON_TZ=America/New_York 0 7 * * 1-5`",
  "",
  "Ask the importing user for:",
  "- Timezone",
].join("\n");

const recipe: GrokRecipe = GrokRecipeSchema.parse({
  profile: { name: "Harbor Desk", title: "Dock Scheduler", description: DESCRIPTION },
  memory: [
    { kind: "profile", content: "Confirm before booking a slot." },
    { kind: "log", content: "The yard opens at six.\nGate B is closed on Sundays." },
    { kind: "profile", content: "Use 24-hour times." },
    { kind: "log", content: "   " },
  ],
  skills: [
    {
      name: "Getting started",
      description: "Ignored: the frontmatter names it.",
      content:
        "---\nname: harbor-desk-getting-started\ndescription: Start here with a new user.\n---\n# Getting started\n\nAsk for the yard name.\n",
    },
    {
      name: "Slot Planner",
      description: "Plans slots.",
      content: "Pick the earliest free slot.\n",
    },
  ],
  routines: [{ slug: "morning-slot-check", name: "Morning slot check", content: morningCheck }],
  plugins: [{ name: "Example Calendar", description: "Reads a calendar." }],
  gettingStarted: { skill: "harbor-desk-getting-started" },
});

/** The same template as the folder converter writes it. */
const folder: Record<string, string> = {
  ".pi/APPEND_SYSTEM.md": "# Harbor Desk\n",
  ".pi/settings.json": "{}\n",
  "package.json": "{}\n",
  "prompts/morning-slot-check.md": "Check the slot board.\n",
  "cron/morning-slot-check.cron": "0 7 * * 1-5\n",
  "systemd/morning-slot-check.timer": "[Timer]\n",
  "AGENTS.md": [
    "# Harbor Desk",
    "",
    "**Title:** Dock Scheduler",
    "",
    DESCRIPTION,
    "",
    "On first run (or when the user is new), follow the `harbor-desk-getting-started` skill (`/skill:harbor-desk-getting-started`).",
    "",
    "Seed memories (rules and facts from the template) are in `MEMORY.md`.",
    "",
    "## Skills",
    "",
    "- `slot-planner`: Plans slots.",
    "",
    "## Running in Pi (conversion note)",
    "",
    "Invented conversion note.",
    "",
  ].join("\n"),
  "MEMORY.md": [
    "# Memory seeds for Harbor Desk",
    "",
    "Invented intro line.",
    "",
    "- **profile** (2026-01-01): Confirm before booking a slot.",
    "- **log** (2026-01-02): The yard opens at six.",
    "  Gate B is closed on Sundays.",
    "- **profile** (2026-01-03): Use 24-hour times.",
    "",
  ].join("\n"),
  "README.md": [
    "# Harbor Desk",
    "",
    "| | |",
    "| --- | --- |",
    `| Original template | ${SHARE_URL} |`,
    "| Creator | Sample Maker ([@samplemaker](https://example.test/samplemaker)) |",
    "",
  ].join("\n"),
  "CONNECTORS.md": [
    "# Connectors",
    "",
    "| Plugin | Grok plugin id | What the template says it is for |",
    "| --- | --- | --- |",
    "| Example Calendar | `1` | Reads a calendar. |",
    "",
  ].join("\n"),
  "routines/morning-slot-check.md": `# Routine: Morning slot check\n\n> Invented summary for people.\n\n${morningCheck}\n`,
  "skills/harbor-desk-getting-started/SKILL.md":
    "---\nname: harbor-desk-getting-started\ndescription: Start here with a new user.\n---\n# Getting started\n\nAsk for the yard name.\n",
  "skills/slot-planner/SKILL.md":
    "---\nname: slot-planner\ndescription: Plans slots.\n---\n\nPick the earliest free slot.\n",
};

function plan(files: AgentImportFile[]): AgentImportPlan {
  const parsed = parseAgentImport(files);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

const fromRecipe = (input: GrokRecipe, creator: string | null = "Sample Maker") =>
  grokBotFiles(grokBotFromRecipe(input, { url: SHARE_URL, name: "Harbor Desk", creator }));

/** What a client sends for a folder, chosen the way the browser chooses it. */
async function upload(files: Record<string, string>, root = "harbor-desk") {
  const paths = Object.keys(files).map((path) => `${root}/${path}`);
  const { entries } = await chooseAgentImportFiles(
    paths,
    (path) => files[path.slice(root.length + 1)] ?? "",
    { includeSecrets: false },
  );
  return agentImportUpload(entries, { includeSecrets: false });
}

const persona = (result: AgentImportPlan) => result.instructions.map((item) => item.content);
const creditLine = (result: AgentImportPlan) =>
  result.instructions[0]?.content.trim().split("\n").at(-1);

describe("Grok Bot recipe", () => {
  it("becomes a persona with its credit, notes as memory, skills, and connectors skipped", () => {
    const result = plan(fromRecipe(recipe));
    expect(result.source).toBe("grok");
    expect(result.suggestedName).toBe("Harbor Desk");
    expect(result.suggestedDescription).toBe(DESCRIPTION);
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0]).toMatchObject({ title: "AGENTS.md", role: "persona" });
    const expected = [
      "**Title:** Dock Scheduler",
      DESCRIPTION,
      "Confirm before booking a slot.",
      "Use 24-hour times.",
      "When the user is new, start with the harbor-desk-getting-started skill.",
      `Based on the Grok Bot template [Harbor Desk](${SHARE_URL}) by Sample Maker.`,
    ].join("\n\n");
    expect(persona(result)).toEqual([`${expected}\n`]);
    expect(result.memory.map(({ path, content }) => ({ path, content }))).toEqual([
      {
        path: "MEMORY.md",
        content: "- The yard opens at six.\n  Gate B is closed on Sundays.\n",
      },
    ]);
    expect(result.skills.map(({ name, description }) => ({ name, description }))).toEqual([
      { name: "harbor-desk-getting-started", description: "Start here with a new user." },
      { name: "slot-planner", description: "Plans slots." },
    ]);
    const planner = parseSkillMd(result.skills[1]!.content);
    expect(planner).toMatchObject({ name: "slot-planner", body: "Pick the earliest free slot.\n" });
    expect(result.skipped).toEqual([
      { path: "CONNECTORS.md: Example Calendar", reason: "unsupported" },
    ]);
    expect(result.routines).toEqual([]);
  });

  it("names the creator only when Cursor names one", () => {
    expect(creditLine(plan(fromRecipe(recipe, null)))).toBe(
      `Based on the Grok Bot template [Harbor Desk](${SHARE_URL}).`,
    );
  });

  it("leaves the title out when it repeats the name, and keeps skills with one name apart", () => {
    const result = plan(
      fromRecipe(
        GrokRecipeSchema.parse({
          profile: { name: "Harbor Desk", title: "harbor desk", description: DESCRIPTION },
          skills: [
            { name: "Slot Planner", content: "First.\n" },
            { name: "slot planner", content: "Second.\n" },
            { name: "", content: "Third.\n" },
          ],
        }),
      ),
    );
    expect(persona(result)[0]).not.toContain("**Title:**");
    const bodies = Object.fromEntries(
      result.skills.map((skill) => {
        const parsed = parseSkillMd(skill.content);
        return [skill.name, "error" in parsed ? parsed.error : parsed.body];
      }),
    );
    expect(bodies).toEqual({
      "slot-planner": "First.\n",
      "slot-planner-2": "Second.\n",
      skill: "Third.\n",
    });
  });

  it("falls back to the template's name when the recipe has none", () => {
    const result = plan(fromRecipe(GrokRecipeSchema.parse({ profile: { name: "  " } })));
    expect(result.suggestedName).toBe("Harbor Desk");
    expect(persona(result)).toEqual([
      `Based on the Grok Bot template [Harbor Desk](${SHARE_URL}) by Sample Maker.\n`,
    ]);
  });
});

describe("Grok Bot template folder", () => {
  it("sends only the template's own files", async () => {
    const sent = (await upload(folder)).map((file) => file.path).sort();
    expect(sent).toEqual(
      [
        ".pi/APPEND_SYSTEM.md",
        "AGENTS.md",
        "CONNECTORS.md",
        "MEMORY.md",
        "README.md",
        "routines/morning-slot-check.md",
        "skills/harbor-desk-getting-started/SKILL.md",
        "skills/slot-planner/SKILL.md",
      ].map((path) => `harbor-desk/${path}`),
    );
  });

  it("gives the same plan as the template's recipe, its credit from the README", async () => {
    const fromFolder = plan(await upload(folder));
    const fromLink = plan(fromRecipe(recipe));
    const withoutCredit = (result: AgentImportPlan) =>
      persona(result).map((text) => text.trim().split("\n\n").slice(0, -1).join("\n\n"));
    const skills = (result: AgentImportPlan) =>
      result.skills.map((skill) => {
        const parsed = parseSkillMd(skill.content);
        return {
          name: skill.name,
          description: skill.description,
          body: "error" in parsed ? parsed : parsed.body.trim(),
        };
      });

    expect(fromFolder.source).toBe("grok");
    expect(fromFolder.suggestedName).toBe(fromLink.suggestedName);
    expect(fromFolder.suggestedDescription).toBe(fromLink.suggestedDescription);
    expect(withoutCredit(fromFolder)).toEqual(withoutCredit(fromLink));
    expect(fromFolder.memory.map((item) => item.content)).toEqual(
      fromLink.memory.map((item) => item.content),
    );
    expect(skills(fromFolder)).toEqual(skills(fromLink));
    expect(fromFolder.skipped).toEqual(fromLink.skipped);
    expect(creditLine(fromFolder)).toBe(
      `Based on the Grok Bot template [Harbor Desk](${SHARE_URL}) by Sample Maker (@samplemaker).`,
    );
  });

  it("names no creator the README calls unknown", async () => {
    const readme = folder["README.md"]!.replace(/\| Creator \|.*\|/, "| Creator | unknown |");
    expect(creditLine(plan(await upload({ ...folder, "README.md": readme })))).toBe(
      `Based on the Grok Bot template [Harbor Desk](${SHARE_URL}).`,
    );
  });
});

describe("Grok Bot credit", () => {
  const bot = (url: string) => ({
    name: "Harbor Desk",
    title: "",
    description: "",
    profile: ["Be brief."],
    notes: [],
    skills: [],
    routines: [],
    connectors: [],
    gettingStarted: null,
    template: { url, name: "Harbor Desk", creator: null },
  });
  const credit = (url: string) =>
    creditLine(plan([{ path: "t/grok-bot.json", content: JSON.stringify(bot(url)) }]));

  it("links only to the template's share page", () => {
    expect(credit(SHARE_URL)).toBe(`Based on the Grok Bot template [Harbor Desk](${SHARE_URL}).`);
    for (const url of [
      "javascript:alert(1)",
      `http://x.ai/bot/${SHARE_ID}`,
      `https://evil.example.test/bot/${SHARE_ID}`,
      `https://x.ai.example.test/bot/${SHARE_ID}`,
      `https://x.ai:8443/bot/${SHARE_ID}`,
      `https://www.x.ai/bot/${SHARE_ID}`,
      `https://x.ai/bot/${SHARE_ID}?next=https://evil.example.test`,
      `https://x.ai/bot/${SHARE_ID}/../../elsewhere`,
      "https://x.ai/bot/too-short",
    ]) {
      expect(credit(url), url).toBe("Based on the Grok Bot template Harbor Desk.");
    }
  });

  it("links a template folder only to a share page", async () => {
    const readme = folder["README.md"]!.replace(SHARE_URL, "https://evil.example.test/bot/x");
    expect(creditLine(plan(await upload({ ...folder, "README.md": readme })))).toBe(
      "Based on the Grok Bot template Harbor Desk by Sample Maker (@samplemaker).",
    );
  });

  it("leaves the credit out when there is no template", () => {
    const file = { ...bot(SHARE_URL), template: null };
    expect(persona(plan([{ path: "t/grok-bot.json", content: JSON.stringify(file) }]))).toEqual([
      "Be brief.\n",
    ]);
  });
});

describe("Grok Bot share links", () => {
  it("reads the id from a share page or the app's link", () => {
    for (const link of [
      SHARE_URL,
      `  https://www.x.ai/bot/${SHARE_ID}/  `,
      `https://x.ai/bot/${SHARE_ID}?utm=example`,
      `x.ai/bot/${SHARE_ID}`,
      `www.x.ai/bot/${SHARE_ID}`,
      `grokbot://app/v1/bot-template?id=${SHARE_ID}`,
    ]) {
      expect(grokShareId(link), link).toBe(SHARE_ID);
    }
  });

  it("reads nothing from any other link", () => {
    for (const link of [
      "",
      SHARE_ID,
      `http://x.ai/bot/${SHARE_ID}`,
      `https://evil.example.test/bot/${SHARE_ID}`,
      `https://x.ai:444/bot/${SHARE_ID}`,
      `https://user:pw@x.ai/bot/${SHARE_ID}`,
      `https://x.ai/bot/${SHARE_ID}/more`,
      `https://x.ai/bots/${SHARE_ID}`,
      "https://x.ai/bot/AAAAAAAAAAAAAAAAAAAA",
      "https://x.ai/bot/AAAAAAAAAAAAAAAAAAAA1A",
      "https://x.ai/bot/AAAAAAAAAAAAAAAAAAA.1",
      `grokbot://other/v1/bot-template?id=${SHARE_ID}`,
      `javascript:alert("${SHARE_ID}")`,
    ]) {
      expect(grokShareId(link), link).toBeNull();
    }
  });
});

describe("OpenClaw and Hermes folders that look like a template", () => {
  const sentAndPlan = async (files: Record<string, string>, root = "ws") => {
    const sent = await upload(files, root);
    const result = plan(sent);
    return {
      sent: sent.map((file) => file.path).sort(),
      source: result.source,
      instructions: result.instructions.map((item) => item.title),
      memory: result.memory.map((item) => item.title),
    };
  };
  const workspace = {
    "AGENTS.md": "# Rules\n\nBe brief.\n",
    "IDENTITY.md": "Name: Pebble\n",
    "USER.md": "Prefers metric units.\n",
    "MEMORY.md": "- likes tea\n",
    "memory/2026-01-01.md": "Planned the week.\n",
  };

  it("keeps an OpenClaw workspace with a Pi folder OpenClaw's, with all of its memory", async () => {
    const withPi = await sentAndPlan({ ...workspace, ".pi/APPEND_SYSTEM.md": "Extra.\n" });
    expect(withPi).toEqual(await sentAndPlan(workspace));
    expect(withPi).toMatchObject({
      source: "openclaw",
      memory: ["MEMORY.md", "USER.md", "memory/2026-01-01.md"],
    });
  });

  it("never sends grok-bot.json, README.md or routines from an OpenClaw workspace", async () => {
    expect(
      await sentAndPlan({
        "SOUL.md": "Calm.\n",
        "grok-bot.json": "{}",
        "README.md": "Readme.\n",
        "CONNECTORS.md": "| a | b |\n",
        "routines/check.md": "Do it.\n",
      }),
    ).toEqual({ sent: ["ws/SOUL.md"], source: "openclaw", instructions: ["SOUL.md"], memory: [] });
  });

  it("keeps a Hermes home with a Pi folder Hermes'", async () => {
    expect(
      await sentAndPlan(
        {
          "SOUL.md": "Calm.\n",
          "memories/MEMORY.md": "A fact.\n",
          "memories/USER.md": "A user.\n",
          ".pi/APPEND_SYSTEM.md": "Extra.\n",
        },
        "h",
      ),
    ).toMatchObject({
      source: "hermes",
      instructions: ["SOUL.md"],
      memory: ["memories/MEMORY.md", "memories/USER.md"],
    });
  });

  it("keeps ~/.openclaw and ~/.hermes theirs", async () => {
    const files = { "AGENTS.md": "Hi.\n", ".pi/APPEND_SYSTEM.md": "Extra.\n", "README.md": "R.\n" };
    expect(await sentAndPlan(files, ".openclaw")).toMatchObject({
      sent: [".openclaw/AGENTS.md"],
      source: "openclaw",
    });
    expect((await sentAndPlan(files, ".hermes")).source).toBe("hermes");
  });
});

describe("hostile Grok Bot templates", () => {
  const N = 99_000;
  const signature = { ".pi/APPEND_SYSTEM.md": "x", "AGENTS.md": "# Bot\n\nHello\n" };
  const timed = (files: Record<string, string>) => {
    const started = performance.now();
    const result = parseAgentImport(
      Object.entries(files).map(([path, content]) => ({ path: `t/${path}`, content })),
    );
    expect(performance.now() - started).toBeLessThan(1_000);
    return result;
  };
  const personaOf = (files: Record<string, string>) => {
    const result = timed(files);
    if ("error" in result) throw new Error(result.error);
    expect(result.source).toBe("grok");
    return result.instructions[0]?.content;
  };

  it("reads long README rows quickly and links no invalid share page", () => {
    expect(
      personaOf({
        ...signature,
        "README.md": `| Original template | https://x.ai/bot/a |\n| Creator | ${" ".repeat(N)}x |\n`,
      }),
    ).toBe("Hello\n\nBased on the Grok Bot template Bot by x.\n");
    expect(
      personaOf({ ...signature, "README.md": `| Original template | ${"| ".repeat(N / 2)}\n` }),
    ).toBe("Hello\n");
    const creator = personaOf({
      ...signature,
      "README.md": `| Original template | https://x.ai/bot/a |\n| Creator | ${"a ".repeat(N / 2)}([@ |\n`,
    });
    expect(creator).toMatch(/^Hello\n\nBased on the Grok Bot template Bot by a a .*\(\[@\.\n$/s);
  });

  it("reads long connector, memory, routine and skill files quickly", () => {
    expect(personaOf({ ...signature, "CONNECTORS.md": `|${"\\|".repeat(N / 2)}\n` })).toBe(
      "Hello\n",
    );
    expect(
      personaOf({
        ...signature,
        "MEMORY.md": `- **${"a".repeat(50)}** (${"x".repeat(50)}\n`.repeat(N / 110),
      }),
    ).toBe("Hello\n");
    expect(
      personaOf({ ...signature, "routines/a.md": `Fires on:\n${"- cron `".repeat(N / 9)}\n` }),
    ).toBe("Hello\n");
    expect(personaOf({ ...signature, "skills/a/SKILL.md": `---\n${"\n".repeat(N)}` })).toBe(
      "Hello\n",
    );
  });

  it("finds nothing in an AGENTS.md of empty headings", () => {
    expect(
      timed({ ...signature, "AGENTS.md": `${"#  ".repeat(N / 3)}\n**Title:**${" ".repeat(N)}` }),
    ).toEqual({ error: "No OpenClaw, Hermes, Grok Bot or agent document found." });
  });

  it("links no credit from an uploaded grok-bot.json that names another address", () => {
    const file = {
      name: "Bot",
      title: "",
      description: "",
      profile: [],
      notes: [],
      skills: [],
      routines: [],
      connectors: [],
      gettingStarted: null,
      template: { url: "javascript:alert(1)", name: "](http://evil.example.test)", creator: "x" },
    };
    expect(personaOf({ "grok-bot.json": JSON.stringify(file) })).toBe(
      "Based on the Grok Bot template ](http://evil.example.test) by x.\n",
    );
  });

  it("refuses a grok-bot.json that is not a template", () => {
    expect(timed({ "grok-bot.json": "{}" })).toHaveProperty("error");
    expect(timed({ "grok-bot.json": "not json" })).toHaveProperty("error");
  });
});
