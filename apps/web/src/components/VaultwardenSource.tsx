import { Trans, useLingui } from "@lingui/react/macro";
import type {
  CredentialSourceCollection,
  SettingsScope,
  VaultwardenConnectInput,
} from "@rakazo/contracts";
import { writeSaved } from "@rakazo/core/query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  Spinner,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";

const PROVIDER = "Vaultwarden";

type Picker = { collections: CredentialSourceCollection[]; selected: readonly string[] };
type SourceDialog =
  | { kind: "connect" }
  // A null picker is still loading the collections.
  | { kind: "collections"; picker: Picker | null }
  | { kind: "disconnect" }
  | null;
type ConnectFields = Omit<VaultwardenConnectInput, "scope">;

/**
 * The vault's Vaultwarden connection: a row while connected, a connect button while not, and the
 * dialogs both open. Its logins are managed in Vaultwarden, so nothing here reveals or edits them.
 */
export function useVaultwardenSource({
  scope,
  disabled,
  onChanged,
}: {
  scope: SettingsScope;
  disabled: boolean;
  /** Reloads the vault list after the logins Vaultwarden provides may have changed. */
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const statusOptions = queries.vault.source.status.queryOptions({ input: { scope } });
  const status = useQuery(statusOptions).data;
  const [dialog, setDialog] = useState<SourceDialog>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = disabled || busy;
  const name = PROVIDER;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  function open(next: SourceDialog) {
    setError(null);
    setDialog(next);
  }

  function close() {
    // Collections still loading may be left; a save or disconnect in flight may not.
    if (!busy || (dialog?.kind === "collections" && !dialog.picker)) open(null);
  }

  const connect = (fields: ConnectFields) =>
    run(async () => {
      const result = await rpc.vault.source.connect({ scope, ...fields });
      await writeSaved(queryClient, statusOptions.queryKey, () => result.status);
      const selected = result.status.connected ? result.status.collectionIds : [];
      setDialog({ kind: "collections", picker: { collections: result.collections, selected } });
    });

  const chooseCollections = () => {
    if (!status?.connected) return;
    open({ kind: "collections", picker: null });
    return run(async () => {
      const { collections } = await rpc.vault.source.collections({ scope });
      setDialog((current) =>
        current?.kind === "collections"
          ? { kind: "collections", picker: { collections, selected: status.collectionIds } }
          : current,
      );
    });
  };

  const saveCollections = (collectionIds: string[]) =>
    run(async () => {
      const next = await rpc.vault.source.setCollections({ scope, collectionIds });
      await writeSaved(queryClient, statusOptions.queryKey, () => next);
      setDialog(null);
      await onChanged();
    });

  const disconnect = () =>
    run(async () => {
      await rpc.vault.source.disconnect({ scope });
      await writeSaved(queryClient, statusOptions.queryKey, () => ({ connected: false as const }));
      setDialog(null);
      await onChanged();
    });

  const row = status?.connected ? (
    <div data-testid="vaultwarden-source" className="rounded-xl bg-muted/50 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium text-foreground">{PROVIDER}</div>
          <div className="truncate text-[12.5px] text-muted-foreground">
            {status.email} · {status.origin}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            data-testid="vaultwarden-menu"
            aria-label={t`More`}
            disabled={blocked}
            render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" />}
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-44">
            <DropdownMenuItem onClick={() => void chooseCollections()}>
              <Trans>Choose collections</Trans>
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => open({ kind: "disconnect" })}>
              <Trans>Disconnect</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {status.lastSyncError ? (
        <p className="mt-1 text-[12.5px] text-destructive">{status.lastSyncError}</p>
      ) : null}
    </div>
  ) : null;

  // Only once the server answered, so an API without Vaultwarden support shows nothing.
  const connectButton =
    status?.connected === false ? (
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="vaultwarden-connect"
        disabled={blocked}
        onClick={() => open({ kind: "connect" })}
      >
        {t`Connect ${name}`}
      </Button>
    ) : null;

  const errorLine = error ? (
    <p role="alert" className="text-[13px] text-destructive">
      {error}
    </p>
  ) : null;

  // Rendered only while open, so a closed form keeps no typed secret in state.
  const dialogs =
    dialog?.kind === "connect" ? (
      <ConnectDialog busy={busy} error={errorLine} onSubmit={connect} onClose={close} />
    ) : dialog?.kind === "collections" ? (
      <CollectionsDialog
        picker={dialog.picker}
        busy={busy}
        error={errorLine}
        onSave={saveCollections}
        onClose={close}
      />
    ) : dialog?.kind === "disconnect" ? (
      <AlertDialog open onOpenChange={(next) => !next && close()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Disconnect ${name}?`}</AlertDialogTitle>
          </AlertDialogHeader>
          {errorLine}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="vaultwarden-disconnect-confirm"
              disabled={busy}
              onClick={() => void disconnect()}
            >
              <Trans>Disconnect</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ) : null;

  return { row, connectButton, dialogs, busy };
}

function ConnectDialog({
  busy,
  error,
  onSubmit,
  onClose,
}: {
  busy: boolean;
  error: ReactNode;
  onSubmit: (fields: ConnectFields) => Promise<void>;
  onClose: () => void;
}) {
  const ids = useId();
  const [fields, setFields] = useState<ConnectFields>({
    baseUrl: "",
    clientId: "",
    clientSecret: "",
    masterPassword: "",
  });
  const ready = Object.values(fields).every((value) => value.trim().length > 0);
  const field = (key: keyof ConnectFields, label: ReactNode, secret = false) => (
    <div>
      <Label htmlFor={`${ids}-${key}`}>{label}</Label>
      <Input
        id={`${ids}-${key}`}
        data-testid={`vaultwarden-${key}`}
        type={secret ? "password" : key === "baseUrl" ? "url" : "text"}
        autoComplete={secret ? "new-password" : "off"}
        spellCheck={false}
        disabled={busy}
        value={fields[key]}
        onChange={(event) => setFields((prev) => ({ ...prev, [key]: event.target.value }))}
        className="mt-1.5"
      />
    </div>
  );
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{PROVIDER}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !busy) void onSubmit(fields);
          }}
        >
          {field("baseUrl", <Trans>Server URL</Trans>)}
          {field("clientId", <Trans>Client ID</Trans>)}
          {field("clientSecret", <Trans>Client secret</Trans>, true)}
          {field("masterPassword", <Trans>Master password</Trans>, true)}
          {error}
          <DialogFooter>
            <Button
              type="submit"
              data-testid="vaultwarden-connect-submit"
              disabled={!ready || busy}
            >
              {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CollectionsDialog({
  picker,
  busy,
  error,
  onSave,
  onClose,
}: {
  picker: Picker | null;
  busy: boolean;
  error: ReactNode;
  onSave: (collectionIds: string[]) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            <Trans>Choose collections</Trans>
          </DialogTitle>
        </DialogHeader>
        {picker ? (
          <CollectionsForm
            picker={picker}
            busy={busy}
            error={error}
            onSave={onSave}
            onClose={onClose}
          />
        ) : (
          (error ?? <Spinner className="mx-auto size-5 text-muted-foreground" />)
        )}
      </DialogContent>
    </Dialog>
  );
}

function CollectionsForm({
  picker,
  busy,
  error,
  onSave,
  onClose,
}: {
  picker: Picker;
  busy: boolean;
  error: ReactNode;
  onSave: (collectionIds: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const ids = useId();
  const known = new Set(picker.collections.map((collection) => collection.id));
  // A saved collection that no longer exists in Vaultwarden is dropped on the next save.
  const [selected, setSelected] = useState(
    () => new Set(picker.selected.filter((id) => known.has(id))),
  );
  const organizations = new Set(
    picker.collections.map((collection) => collection.organizationName),
  );
  const toggle = (id: string, checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) void onSave([...selected]);
      }}
    >
      {picker.collections.length ? (
        <ul className="max-h-72 space-y-2.5 overflow-y-auto">
          {picker.collections.map((collection) => (
            <li key={collection.id} className="flex items-center gap-2.5">
              <Checkbox
                id={`${ids}-${collection.id}`}
                data-testid="vaultwarden-collection"
                checked={selected.has(collection.id)}
                disabled={busy}
                onCheckedChange={(checked) => toggle(collection.id, checked)}
              />
              <Label htmlFor={`${ids}-${collection.id}`} className="min-w-0 font-normal">
                <span className="truncate">{collection.name}</span>
                {organizations.size > 1 && collection.organizationName ? (
                  <span className="truncate text-muted-foreground">
                    {collection.organizationName}
                  </span>
                ) : null}
              </Label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          <Trans>No collections</Trans>
        </p>
      )}
      {error}
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" data-testid="vaultwarden-collections-save" disabled={busy}>
          <Trans>Save</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
