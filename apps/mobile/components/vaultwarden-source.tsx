import { MenuView } from "@expo/ui/community/menu";
import type {
  CredentialSourceCollection,
  CredentialSourceStatus,
  SettingsScope,
} from "@rakazo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { rpc as apiRpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useResolvedAppearance, useThemedStyles } from "../lib/native";
import { useSecretSheetClose } from "../lib/secret-sheet-close";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "./settings-group";

const PROVIDER = "Vaultwarden";

type Rpc = typeof apiRpc;
type Picker = { collections: CredentialSourceCollection[]; selected: readonly string[] };
// A null picker is still loading the collections.
type SheetStep = { step: "connect" } | { step: "collections"; picker: Picker | null };
type SourceAction = "collections" | "disconnect";

/**
 * The vault's Vaultwarden connection: a row with its actions while connected, a connect row while
 * not. Its logins are managed in Vaultwarden, so nothing here reveals or edits them.
 */
export function VaultwardenSource({
  rpc,
  scope,
  disabled,
  onChanged,
}: {
  rpc: Rpc;
  scope: SettingsScope;
  disabled: boolean;
  /** Reloads the vault list after the logins Vaultwarden provides may have changed. */
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const colorScheme = useResolvedAppearance();
  const styles = useThemedStyles(createStyles);
  const [status, setStatus] = useState<CredentialSourceStatus | null>(null);
  const [sheet, setSheet] = useState<SheetStep | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let current = true;
      // An API without Vaultwarden support answers with an error, which leaves this hidden.
      void rpc("vault/source/status", { scope }).then(
        (next) => {
          if (current) setStatus(next);
        },
        () => undefined,
      );
      return () => {
        current = false;
      };
    }, [rpc, scope]),
  );

  async function disconnect() {
    setPending(true);
    setError(null);
    try {
      await rpc("vault/source/disconnect", { scope });
      setStatus({ connected: false });
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  }

  function runAction(action: SourceAction) {
    if (pending || disabled) return;
    setError(null);
    if (action === "collections") setSheet({ step: "collections", picker: null });
    else
      Alert.alert(t("Disconnect {name}?", { name: PROVIDER }), undefined, [
        { text: t("Cancel"), style: "cancel" },
        { text: t("Disconnect"), style: "destructive", onPress: () => void disconnect() },
      ]);
  }

  if (!status) return null;
  const inactive = pending || disabled;
  const shownError = error ?? (status.connected ? status.lastSyncError : null);
  return (
    <>
      <SettingsGroup>
        {status.connected ? (
          <MenuView
            actions={[
              { id: "collections", title: t("Choose collections") },
              { id: "disconnect", title: t("Disconnect"), attributes: { destructive: true } },
            ]}
            colorScheme={colorScheme}
            onPressAction={(event) => {
              const action = event.nativeEvent.event;
              if (action === "collections" || action === "disconnect") runAction(action);
            }}
            title={PROVIDER}
          >
            <SettingsRow
              accessible
              accessibilityRole="button"
              dimmed={inactive}
              title={PROVIDER}
              detail={`${status.email} · ${status.origin}`}
            />
          </MenuView>
        ) : (
          <SettingsRow
            accessibilityRole="button"
            disabled={inactive}
            dimmed={inactive}
            onPress={() => setSheet({ step: "connect" })}
            title={t("Connect {name}", { name: PROVIDER })}
          />
        )}
      </SettingsGroup>
      {shownError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {shownError}
        </Text>
      ) : null}
      {sheet ? (
        <VaultwardenSheet
          rpc={rpc}
          scope={scope}
          initial={sheet}
          savedCollectionIds={status.connected ? status.collectionIds : []}
          onStatus={setStatus}
          onChanged={onChanged}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </>
  );
}

/**
 * Connects Vaultwarden, then picks the collections bots may use. The client secret and master
 * password live only in this sheet's state and are cleared once the connection is made or the
 * sheet closes.
 */
function VaultwardenSheet({
  rpc,
  scope,
  initial,
  savedCollectionIds,
  onStatus,
  onChanged,
  onClose,
}: {
  rpc: Rpc;
  scope: SettingsScope;
  initial: SheetStep;
  savedCollectionIds: readonly string[];
  onStatus: (status: CredentialSourceStatus) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const secretInputs = useRef<(TextInput | null)[]>([]);
  const [step, setStep] = useState(initial);
  const [baseUrl, setBaseUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [secrets, setSecrets] = useState({ clientSecret: "", masterPassword: "" });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const clearSecrets = () => setSecrets({ clientSecret: "", masterPassword: "" });
  const { close, closing, endEditing } = useSecretSheetClose(secretInputs, clearSecrets, onClose);
  const editable = !submitting && !closing;

  function showPicker(picker: Picker) {
    const known = new Set(picker.collections.map((collection) => collection.id));
    setSelected(new Set(picker.selected.filter((id) => known.has(id))));
    setStep({ step: "collections", picker });
  }

  useEffect(() => {
    if (initial.step !== "collections" || initial.picker) return;
    let current = true;
    void rpc("vault/source/collections", { scope }).then(
      ({ collections }) => {
        if (current) showPicker({ collections, selected: savedCollectionIds });
      },
      (err: unknown) => {
        if (current) setError(errorText(err));
      },
    );
    return () => {
      current = false;
    };
  }, []);

  const connectReady =
    [baseUrl, clientId, secrets.clientSecret].every((value) => value.trim().length > 0) &&
    secrets.masterPassword.length > 0;
  const ready = step.step === "connect" ? connectReady : step.picker !== null;
  const cancel = () => {
    if (!submitting) close();
  };

  async function submit() {
    if (submitting || !ready) return;
    setSubmitting(true);
    setError(null);
    try {
      if (step.step === "connect") {
        const result = await rpc("vault/source/connect", {
          scope,
          baseUrl,
          clientId,
          ...secrets,
        });
        clearSecrets();
        for (const input of secretInputs.current) input?.clear();
        onStatus(result.status);
        showPicker({
          collections: result.collections,
          selected: result.status.connected ? result.status.collectionIds : [],
        });
      } else {
        onStatus(await rpc("vault/source/setCollections", { scope, collectionIds: [...selected] }));
        onChanged();
        close();
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSubmitting(false);
    }
  }

  const field = (props: {
    label: string;
    value: string;
    onChange: (text: string) => void;
    secret?: 0 | 1;
    url?: boolean;
  }) => {
    const index = props.secret;
    return (
      <TextInput
        ref={
          index === undefined
            ? undefined
            : (node) => {
                secretInputs.current[index] = node;
              }
        }
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChange}
        placeholder={props.label}
        placeholderTextColor={styles.placeholder.color}
        secureTextEntry={props.secret !== undefined}
        autoCorrect={false}
        autoCapitalize="none"
        keyboardType={props.url ? "url" : "default"}
        textContentType="none"
        autoComplete="off"
        editable={editable}
        onEndEditing={
          props.secret === undefined ? undefined : (event) => endEditing(event.nativeEvent.text)
        }
        style={styles.field}
      />
    );
  };

  const organizations =
    step.step === "collections" && step.picker
      ? new Set(step.picker.collections.map((collection) => collection.organizationName))
      : new Set();

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={cancel}>
      <View
        accessibilityViewIsModal
        style={[
          styles.sheet,
          // Page sheets clear the notch on iOS; Android modals are full-screen.
          {
            paddingTop: Platform.OS === "ios" ? 12 : insets.top + 12,
            paddingBottom: insets.bottom,
          },
        ]}
      >
        <View style={styles.header}>
          <NativeActionButton
            disabled={submitting}
            label={t("Cancel")}
            onPress={cancel}
            prominence="plain"
          />
          <NativeActionButton
            disabled={!ready}
            busy={submitting}
            fill={false}
            label={step.step === "connect" ? t("Connect") : t("Save")}
            onPress={() => void submit()}
            prominence={ready ? "primary" : "plain"}
          />
        </View>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          <Text accessibilityRole="header" style={styles.title}>
            {step.step === "connect" ? PROVIDER : t("Choose collections")}
          </Text>
          {step.step === "connect" ? (
            <>
              {field({ label: t("Server URL"), value: baseUrl, onChange: setBaseUrl, url: true })}
              {field({ label: t("Client ID"), value: clientId, onChange: setClientId })}
              {field({
                label: t("Client secret"),
                value: secrets.clientSecret,
                onChange: (clientSecret) => setSecrets((prev) => ({ ...prev, clientSecret })),
                secret: 0,
              })}
              {field({
                label: t("Master password"),
                value: secrets.masterPassword,
                onChange: (masterPassword) => setSecrets((prev) => ({ ...prev, masterPassword })),
                secret: 1,
              })}
            </>
          ) : step.picker?.collections.length ? (
            <SettingsGroup>
              {step.picker.collections.map((collection) => (
                <SettingsSwitch
                  key={collection.id}
                  label={collection.name}
                  detail={organizations.size > 1 ? collection.organizationName : undefined}
                  value={selected.has(collection.id)}
                  disabled={!editable}
                  onChange={(on) =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (on) next.add(collection.id);
                      else next.delete(collection.id);
                      return next;
                    })
                  }
                />
              ))}
            </SettingsGroup>
          ) : step.picker ? (
            <Text style={styles.detail}>{t("No collections")}</Text>
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    sheet: { flex: 1, backgroundColor: tokens.background },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 20,
      paddingBottom: 12,
    },
    content: { paddingHorizontal: 20, paddingBottom: 40, gap: 12 },
    title: { color: tokens.foreground, fontSize: 20, fontWeight: "600" },
    detail: { color: tokens.mutedForeground, fontSize: 15 },
    field: {
      backgroundColor: tokens.muted,
      borderRadius: 13,
      padding: 16,
      color: tokens.foreground,
    },
    placeholder: { color: tokens.faintForeground },
    error: { color: tokens.destructive, fontSize: 13 },
  });
}
