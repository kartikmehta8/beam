/**
 * @file Profile identity rows: "World ID" (link once with a World ID approval
 * and an onchain `linkHuman`) and "Your handle" (claim `<label>.<parent>.eth`
 * with a World ID `handle` approval, one per person; copy it once claimed).
 */
import { Icon } from './Icon';
import * as Haptics from 'expo-haptics';
import { useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, Share, StyleSheet, TextInput, View } from 'react-native';
import type { Address } from 'viem';
import { claimHandle } from '../handles';
import { useAccountCall, useHandleAvailability, type HandleCheck } from '../hooks';
import type { BeamPayAccount } from '../beamPayClient';
import { ApiError, worldOf, type ServerStatus } from '../serverApi';
import { colors, radius, space, type as typeScale } from '../theme';
import { WORLD_OFF } from '../validateIntent';
import { ApprovalSheet } from './ApprovalSheet';
import { EnsMark, WorldMark } from './logos';
import { Sheet } from './Sheet';
import { Button, ListRow, Text } from './ui';
import { useCopy } from './useCopy';

const UNREACHABLE = "Couldn't reach the Beam server.";
const NEEDS_WORLD = 'Link World ID to claim a handle. One per person.';

/**
 * Round tile holding a partner logo, sized like `IconTile`.
 * @param props.children The logo.
 * @returns The tile.
 */
function LogoTile({ children }: { children: ReactNode }) {
  return <View style={styles.tile}>{children}</View>;
}

/**
 * Error line under a row.
 * @param props.text Copy.
 * @returns The line.
 */
function RowError({ text }: { text: string }) {
  return (
    <Text variant="caption" color="danger" style={styles.rowError} accessibilityLiveRegion="polite">
      {text}
    </Text>
  );
}

type WorldProps = {
  address: Address | null;
  account: BeamPayAccount | null;
  accountError: boolean;
  server: ServerStatus;
  onLinked: () => void;
  /** Hairline above the row. */
  divider?: boolean;
};

/**
 * "World ID" row: Link, Linking…, or Linked.
 * @param props.address Wallet address.
 * @param props.account BeamPay link state; null while loading or without BeamPay.
 * @param props.accountError The last account read failed.
 * @param props.server Server status (World ID mode).
 * @param props.onLinked Reloads the account after linking.
 * @param props.divider Hairline above the row.
 * @returns The row, its error line and the approval sheet.
 */
export function WorldIdRow({ address, account, accountError, server, onLinked, divider }: WorldProps) {
  const [approving, setApproving] = useState(false);
  const call = useAccountCall(onLinked);
  const world = worldOf(server);

  let subtitle: string;
  if (world === 'off') subtitle = WORLD_OFF;
  else if (account?.linked) subtitle = 'World ID linked. Only payments over your cap need a fresh check.';
  else if (call.sending) subtitle = 'Linking…';
  else if (account) subtitle = 'Verify you are a real human, once. Needed for payments over your cap.';
  else if (accountError) subtitle = "Couldn't check World ID. Pull to refresh.";
  else subtitle = server.kind === 'unreachable' ? UNREACHABLE : 'Checking…';

  const canLink = !!address && !!account && !account.linked && world !== 'off' && world !== null && !call.sending;
  let trailing: ReactNode = null;
  if (account?.linked) trailing = <Icon name="check-circle" size={22} color={colors.success} />;
  else if (call.sending) trailing = <ActivityIndicator color={colors.primary} />;
  else if (canLink) trailing = <Button size="sm" label="Link" onPress={() => setApproving(true)} />;

  return (
    <>
      <ListRow
        leading={
          <LogoTile>
            <WorldMark size={22} />
          </LogoTile>
        }
        title="World ID"
        subtitle={subtitle}
        divider={divider}
        trailing={trailing}
        accessibilityLabel={`World ID. ${subtitle}`}
      />
      {call.error ? <RowError text={call.error} /> : null}
      <ApprovalSheet
        visible={approving}
        request={address ? { kind: 'link', wallet: address } : null}
        title="Link World ID"
        detail="Link this wallet to you as a unique human, once. After that, only payments over your cap need a fresh World ID check. Everything else is just your fingerprint."
        onApproved={({ result }) => {
          if (result.alreadyLinked) return onLinked();
          if (!result.humanHash || !result.signature || result.deadline === undefined) return;
          void call.run(
            { kind: 'linkHuman', humanHash: result.humanHash, approval: { signature: result.signature, deadline: result.deadline } },
            'Link World ID',
          );
        }}
        onClose={() => setApproving(false)}
      />
    </>
  );
}

/** Claim failures in plain words. */
const CLAIM_COPY: Partial<Record<ApiError['code'], string>> = {
  HANDLE_TAKEN: 'That handle is taken.',
  HANDLE_INVALID: "That handle isn't allowed.",
  HANDLE_CHAIN_ERROR: "Couldn't register it onchain yet. Try again.",
  HANDLES_NOT_CONFIGURED: "Handles aren't set up on this server yet.",
  NOT_LINKED: NEEDS_WORLD,
  APPROVAL_EXPIRED: 'Approval expired. Try again.',
  APPROVAL_USED: 'That approval was already used. Approve again.',
  OFFLINE: UNREACHABLE,
};

/**
 * Availability line under the label field.
 * @param props.check Current check.
 * @returns The line, or null when the field is empty.
 */
function AvailabilityLine({ check }: { check: HandleCheck }) {
  switch (check.kind) {
    case 'empty':
      return null;
    case 'invalid':
      return (
        <Text variant="caption" color="danger" accessibilityLiveRegion="polite">
          {check.message}
        </Text>
      );
    case 'checking':
      return (
        <Text variant="caption" color="textTertiary">
          Checking…
        </Text>
      );
    case 'error':
      return (
        <Text variant="caption" color="danger" accessibilityLiveRegion="polite">
          {"Couldn't check that handle. Try again."}
        </Text>
      );
    case 'result':
      return check.availability.available ? (
        <Text variant="caption" color="success" accessibilityLiveRegion="polite">
          {check.availability.name} is available
        </Text>
      ) : (
        <Text variant="caption" color="danger" accessibilityLiveRegion="polite">
          {check.availability.reason ?? 'That handle is taken.'}
        </Text>
      );
  }
}

type ClaimProps = {
  visible: boolean;
  address: Address;
  linked: boolean;
  worldOff: boolean;
  onClose: () => void;
  onClaimed: () => void;
};

/**
 * Handle claim sheet: label field with live rules and availability, then a
 * World ID `handle` approval and the claim. Remount per open.
 * @param props.visible Whether the sheet is open.
 * @param props.address Wallet the handle will point to.
 * @param props.linked World ID is linked (required to claim).
 * @param props.worldOff World ID is off on the server.
 * @param props.onClose Closes the sheet.
 * @param props.onClaimed Called after the handle is registered.
 * @returns The claim sheet plus its approval sheet.
 */
function ClaimSheet({ visible, address, linked, worldOff, onClose, onClaimed }: ClaimProps) {
  const [raw, setRaw] = useState('');
  const [approving, setApproving] = useState(false);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = useHandleAvailability(raw);
  const available = check.kind === 'result' && check.availability.available ? check.availability : null;

  const inFlight = useRef(false);

  const claim = async (label: string, id: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setClaiming(true);
    setError(null);
    try {
      await claimHandle({ label, wallet: address, approvalId: id });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onClaimed();
      onClose();
    } catch (e) {
      setError((e instanceof ApiError && CLAIM_COPY[e.code]) || 'Something went wrong. Try again.');
    } finally {
      inFlight.current = false;
      setClaiming(false);
    }
  };

  const blockedBy = worldOff ? WORLD_OFF : linked ? null : NEEDS_WORLD;

  return (
    <>
      <Sheet visible={visible && !approving} onClose={onClose} title="Claim your handle">
        <Text variant="callout" color="textSecondary">
          A name anyone can pay instead of your address. Requires World ID. One per person.
        </Text>
        <TextInput
          value={raw}
          editable={!claiming}
          onChangeText={(v) => {
            setRaw(v);
            setApprovalId(null);
            setError(null);
          }}
          placeholder="yourname"
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          maxLength={20}
          accessibilityLabel="Handle"
          style={[styles.field, check.kind === 'invalid' && styles.fieldError]}
        />
        <AvailabilityLine check={check} />
        {blockedBy ? (
          <Text variant="caption" color="textSecondary">
            {blockedBy}
          </Text>
        ) : null}
        {error ? (
          <Text variant="caption" color="danger" accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}
        {claiming ? (
          <View style={styles.progress} accessibilityLiveRegion="polite">
            <ActivityIndicator color={colors.primary} />
            <View style={styles.progressText}>
              <Text variant="bodyStrong">Claiming your handle…</Text>
              <Text variant="caption" color="textSecondary">
                This takes about 30 seconds while ENS confirms it on Ethereum.
              </Text>
            </View>
          </View>
        ) : approvalId && available ? (
          <Button label="Try again" icon="refresh-cw" onPress={() => void claim(available.label, approvalId)} />
        ) : (
          <Button
            label="Claim with World ID"
            leading={<WorldMark size={18} color={colors.textInverse} />}
            disabled={!available || !!blockedBy}
            onPress={() => setApproving(true)}
          />
        )}
      </Sheet>
      <ApprovalSheet
        visible={approving}
        request={{ kind: 'handle', wallet: address }}
        title="Claim your handle"
        detail={available ? `Approve claiming ${available.name}.` : ''}
        onApproved={({ approvalId: id }) => {
          setApprovalId(id);
          if (available) void claim(available.label, id);
        }}
        onClose={() => setApproving(false)}
      />
    </>
  );
}

type HandleProps = {
  address: Address | null;
  /** undefined while loading or unavailable, null when none. */
  handle: string | null | undefined;
  handleError: boolean;
  account: BeamPayAccount | null;
  server: ServerStatus;
  onClaimed: () => void;
};

/**
 * "Your handle" row: claim one, or show it with copy and share.
 * @param props.address Wallet address.
 * @param props.handle The wallet's handle.
 * @param props.handleError The last handle lookup failed.
 * @param props.account BeamPay link state (claiming needs World ID).
 * @param props.server Server status (handles and World ID modes).
 * @param props.onClaimed Reloads the handle after a claim.
 * @returns The row and its claim sheet.
 */
export function HandleRow({ address, handle, handleError, account, server, onClaimed }: HandleProps) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  const { copied, copy } = useCopy();
  const world = worldOf(server);
  const ready = world !== null && (server.kind === 'ok' || server.kind === 'mismatch');
  const mark = (
    <LogoTile>
      <EnsMark size={20} />
    </LogoTile>
  );

  if (handle) {
    return (
      <View style={styles.handleRow} accessible accessibilityLabel={`Your handle ${handle}`}>
        {mark}
        <View style={styles.rowText}>
          <Text variant="bodyStrong" numberOfLines={1} ellipsizeMode="middle">
            {handle}
          </Text>
          <Text variant="caption" color={copied ? 'success' : 'textSecondary'} numberOfLines={1}>
            {copied ? 'Copied' : 'Your Beam handle on ENS'}
          </Text>
        </View>
        <View style={styles.iconActions}>
          <IconAction icon={copied ? 'check' : 'copy'} label={copied ? 'Handle copied' : 'Copy handle'} onPress={() => void copy(handle)} />
          <IconAction icon="share-2" label="Share handle" onPress={() => void Share.share({ message: handle })} />
        </View>
      </View>
    );
  }

  let subtitle: string;
  if (ready && !server.handles) subtitle = "Handles aren't set up on this server yet.";
  else if (server.kind === 'unreachable' || handleError) subtitle = UNREACHABLE;
  else if (handle === null) subtitle = 'Claim a name anyone can pay. Requires World ID.';
  else subtitle = 'Checking…';
  const canClaim = ready && server.handles && handle === null && !!address;

  return (
    <>
      <ListRow
        leading={mark}
        title="Your handle"
        subtitle={subtitle}
        onPress={
          canClaim
            ? () => {
                setSession((n) => n + 1);
                setOpen(true);
              }
            : undefined
        }
        accessibilityLabel={`Your handle. ${subtitle}`}
      />
      {canClaim && address ? (
        <ClaimSheet
          key={session}
          visible={open}
          address={address}
          linked={!!account?.linked}
          worldOff={world === 'off'}
          onClose={() => setOpen(false)}
          onClaimed={onClaimed}
        />
      ) : null}
    </>
  );
}

/**
 * 48-pt icon button.
 * @param props.icon Feather icon.
 * @param props.label Accessible label.
 * @param props.onPress Press handler.
 * @returns The button.
 */
function IconAction({ icon, label, onPress }: { icon: 'copy' | 'check' | 'share-2'; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.iconAction, pressed && styles.pressed]}
    >
      <Icon name={icon} size={18} color={icon === 'check' ? colors.success : colors.textSecondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted },
  rowError: { paddingBottom: space.sm },
  handleRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  rowText: { flex: 1, gap: space.xxs },
  iconActions: { flexDirection: 'row', gap: space.sm },
  iconAction: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pressed: { backgroundColor: colors.surfaceMuted },
  field: {
    ...typeScale.body,
    minHeight: 56,
    paddingHorizontal: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceMuted,
    color: colors.text,
  },
  fieldError: { borderColor: colors.danger },
  progress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.primarySoft,
  },
  progressText: { flex: 1, gap: space.xxs },
});
