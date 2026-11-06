/**
 * @file "Review payment" card: amount, recipient (ENS name, avatar and
 * primary-name badge, full address, source), fee/total/balance-after,
 * plain-language warnings, the World ID approval row, expiry, then Approve
 * with World ID (when required), Confirm/Cancel (or hold-to-confirm) and the
 * execution status with explorer links.
 */
import { Icon } from './Icon';
import type { ConnectedEthereumWallet } from '@privy-io/expo';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import type { Address } from 'viem';
import type { ApprovalRequest } from '../api';
import { NETWORK } from '../config';
import { useIntentExecution } from '../execute';
import type { PaymentAuthorization } from '../paymentAuthorization';
import { shortAddress, type ApprovalReason, type Intent, type IntentWarning } from '../intent';
import { colors, radius, space } from '../theme';
import { intentCost } from '../validateIntent';
import { ApprovalSheet } from './ApprovalSheet';
import { money, moneyParts } from './format';
import { HoldButton } from './HoldButton';
import { WorldMark } from './logos';
import { PaymentStatus } from './PaymentStatus';
import { RecipientBlock } from './RecipientBlock';
import { Button, Card, Text } from './ui';

/** Plain-language copy for each warning. */
const WARNING_COPY: Record<IntentWarning, string> = {
  NEW_RECIPIENT: "You haven't paid this address before. Check it matches.",
  RECIPIENT_IS_CONTRACT: 'This address is a contract. Funds may not be recoverable.',
  SELF_TRANSFER: 'This is your own address.',
  AMOUNT_NOT_IN_CONTEXT: "This amount doesn't appear on your screen or in your message.",
  PARSED_WITHOUT_AI: 'Read by the basic parser while the agent is offline. Double-check every detail.',
  CLOSE_TO_DAILY_LIMIT: "This uses most of today's spending limit.",
  NAME_NOT_PRIMARY: "This name points here, but it isn't their primary name.",
  NAME_ADDRESS_CHANGED: 'This name now points to a new address.',
};

/**
 * Why World ID approval is needed, in plain words.
 * @param reason Approval reason.
 * @param capWei Current per-payment cap, when known.
 * @returns Short phrase.
 */
function reasonCopy(reason: ApprovalReason, capWei: bigint | null): string {
  switch (reason) {
    case 'OVER_CAP':
      return capWei === null ? 'Over your per-payment cap' : `Over your ${money(capWei)} cap`;
    case 'NEW_RECIPIENT':
      return 'First payment to this person';
    case 'NAME_CHANGED':
      return 'This name now points to a new address';
    case 'EXTERNAL_AGENT':
      return 'Requested by an outside agent';
  }
}

type Props = {
  intent: Intent;
  authorization: PaymentAuthorization;
  wallet: ConnectedEthereumWallet | null;
  address: Address | null;
  /** Called when the payment confirms or reverts. */
  onSettled?: () => void;
};

/**
 * Review card for one intent.
 * @param props.intent Locally prepared intent.
 * @param props.authorization Device-only permission from the current payment scope.
 * @param props.wallet Privy embedded wallet (null while being created).
 * @param props.address Wallet address.
 * @param props.onSettled Refresh hook after the payment settles.
 * @returns The card, or a one-line note once the user cancels it.
 */
export function IntentCard({ intent, authorization, wallet, address, onSettled }: Props) {
  const exec = useIntentExecution(intent, authorization, wallet, address, onSettled);
  const [declined, setDeclined] = useState(false);
  const [approving, setApproving] = useState(false);
  const { state, check, balanceWei, capWei, walletStatus, authMode, approval } = exec;
  const cost = intentCost(intent);
  const hero = moneyParts(BigInt(intent.amountWei), true);
  const actionable = state.status === 'idle' || state.status === 'cancelled';
  // Buttons stay disabled until checks pass and the wallet provider has resolved (spinner meanwhile).
  const preparing = check === null || walletStatus === 'loading';
  const blocked = !check?.ok || walletStatus !== 'ready' || authMode === null;
  const needsApproval = intent.route === 'payWithApproval' && !approval;
  const short = balanceWei !== null && cost !== null && balanceWei < cost.total;
  // Ellipsis while the balance loads; never a negative balance.
  const balanceAfter = short ? `Not enough ${NETWORK.symbol}` : balanceWei !== null && cost ? money(balanceWei - cost.total) : '…';
  const recipient = intent.toName ?? shortAddress(intent.to);
  const request: ApprovalRequest | null = address
    ? {
        kind: 'pay',
        wallet: address,
        pay: {
          intentId: intent.id,
          to: intent.to,
          amountWei: intent.amountWei,
          intentHash: intent.intentHash,
          expiresAt: intent.expiresAt,
        },
      }
    : null;

  if (declined) {
    return (
      <View style={styles.declined} accessibilityRole="text">
        <Icon name="x-circle" size={14} color={colors.textTertiary} />
        <Text variant="caption" color="textTertiary">
          Payment of {money(BigInt(intent.amountWei))} cancelled.
        </Text>
      </View>
    );
  }

  return (
    <Card style={styles.card}>
      <View style={styles.header}>
        <Text variant="overline" color="textTertiary" accessibilityRole="header">
          Review payment
        </Text>
        {actionable ? <ExpiryCountdown expiresAt={intent.expiresAt} /> : null}
      </View>

      <View style={styles.amount} accessible accessibilityLabel={`Send ${hero.value} ${hero.unit}`}>
        <Text variant="display">{hero.value}</Text>
        <Text variant="headline" color="textSecondary" style={styles.unit}>
          {hero.unit}
        </Text>
      </View>

      <RecipientBlock intent={intent} />

      <View>
        <DetailRow label="Network fee" value={cost ? money(cost.fee) : intent.estFeeDisplay} />
        <DetailRow label="Total" value={cost ? money(cost.total) : '…'} strong />
        <DetailRow label="Balance after" value={balanceAfter} />
      </View>

      {intent.warnings.length ? (
        <View style={styles.stack}>
          {intent.warnings.map((w) => (
            <View key={w} style={styles.warning} accessibilityRole="alert">
              <Icon name="alert-triangle" size={15} color={colors.warning} style={styles.rowIcon} />
              <Text variant="caption" color="warning" style={styles.flex}>
                {WARNING_COPY[w]}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {intent.route === 'payWithApproval' ? (
        <ApprovalRow approved={!!approval} reasons={intent.approvalReasons.map((r) => reasonCopy(r, capWei))} />
      ) : null}

      {actionable ? (
        <View style={styles.stack}>
          {check && !check.ok ? (
            <ReasonRow text={check.reason}>
              {check.fix === 'retry' ? (
                <Button size="sm" variant="secondary" icon="refresh-cw" label="Try again" onPress={() => void exec.recheck()} />
              ) : null}
              {check.fix === 'linkWorld' ? (
                <Button size="sm" variant="secondary" icon="user" label="Open Profile" onPress={() => router.replace('/profile')} />
              ) : null}
              {short ? (
                <Button
                  size="sm"
                  variant="secondary"
                  icon="droplet"
                  label={`Get testnet ${NETWORK.symbol}`}
                  onPress={() => void Linking.openURL(NETWORK.faucetUrl)}
                />
              ) : null}
            </ReasonRow>
          ) : null}
          {exec.approvalNote && needsApproval ? <ReasonRow text={exec.approvalNote} /> : null}
          {walletStatus === 'error' ? <ReasonRow text="Your wallet isn't ready. Close and reopen Beam." /> : null}
          {state.status === 'cancelled' ? (
            <Text variant="caption" color="textSecondary" align="center" accessibilityLiveRegion="polite">
              Not confirmed. You can try again.
            </Text>
          ) : null}
          {needsApproval ? (
            <Button
              label="Approve with World ID"
              leading={<WorldMark size={18} color={colors.textInverse} />}
              loading={preparing}
              disabled={blocked}
              accessibilityHint="Opens World ID to approve this payment"
              onPress={() => setApproving(true)}
            />
          ) : authMode === 'hold' ? (
            <HoldButton disabled={blocked || preparing} onComplete={() => void exec.confirm()} />
          ) : (
            <Button
              label="Confirm"
              icon="shield"
              loading={preparing}
              disabled={blocked}
              accessibilityHint="Asks for your fingerprint or PIN, then sends"
              onPress={() => void exec.confirm()}
            />
          )}
          <Button
            variant="ghost"
            label="Cancel"
            onPress={() => {
              void Haptics.selectionAsync();
              setDeclined(true);
            }}
          />
        </View>
      ) : (
        <PaymentStatus state={state} onCheckAgain={() => void exec.checkAgain()} />
      )}

      <ApprovalSheet
        visible={approving}
        request={request}
        title="World ID approval needed"
        detail={`Approve sending ${money(BigInt(intent.amountWei))} to ${recipient}.`}
        payment
        onApproved={({ result }) => {
          if (result.signature && result.deadline !== undefined) exec.setApproval({ signature: result.signature, deadline: result.deadline });
        }}
        onClose={() => setApproving(false)}
      />
    </Card>
  );
}

/**
 * "World ID approval needed" row with the reasons, or the approved state.
 * @param props.approved An approval is held.
 * @param props.reasons Plain-language reasons.
 * @returns The row.
 */
function ApprovalRow({ approved, reasons }: { approved: boolean; reasons: string[] }) {
  return (
    <View style={styles.approval} accessible accessibilityLabel={approved ? 'Approved by you on World ID' : `World ID approval needed. ${reasons.join('. ')}`}>
      <View style={styles.worldTile}>
        <WorldMark size={22} />
      </View>
      <View style={styles.flex}>
        <Text variant="captionStrong">{approved ? 'Approved by you on World ID' : 'World ID approval needed'}</Text>
        {approved ? null : (
          <Text variant="caption" color="textSecondary">
            {reasons.join(' · ')}
          </Text>
        )}
      </View>
      {approved ? <Icon name="check-circle" size={18} color={colors.success} /> : null}
    </View>
  );
}

/**
 * Label/value row with a hairline divider above it.
 * @param props.label Row label.
 * @param props.value Right-aligned value.
 * @param props.strong Emphasize the value (the total).
 * @returns A row.
 */
function DetailRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.row} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text variant="overline" color="textTertiary">
        {label}
      </Text>
      <Text variant={strong ? 'amount' : 'callout'} style={styles.tabular}>
        {value}
      </Text>
    </View>
  );
}

/**
 * Muted row explaining why Confirm is disabled, with optional fix-it actions.
 * @param props.text Reason.
 * @param props.children Small action buttons.
 * @returns The row.
 */
function ReasonRow({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <View style={styles.reason}>
      <View style={styles.reasonHead}>
        <Icon name="info" size={15} color={colors.textSecondary} style={styles.rowIcon} />
        <Text variant="captionStrong" color="textSecondary" style={styles.flex} accessibilityLiveRegion="polite">
          {text}
        </Text>
      </View>
      {children ? <View style={styles.reasonActions}>{children}</View> : null}
    </View>
  );
}

/**
 * Subtle "Expires in m:ss" label; owns its own one-second timer so the card doesn't re-render.
 * The expiry check itself lives in `useIntentExecution`, which re-validates at `expiresAt`.
 * @param props.expiresAt Intent expiry (epoch ms).
 * @returns The label.
 */
function ExpiryCountdown({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(Date.now);
  const left = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const expired = left === 0;

  useEffect(() => {
    if (expired) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expired]);

  const label = expired ? 'Expired' : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  return (
    <View style={styles.inline} accessible accessibilityLabel={expired ? 'Payment expired' : `Expires in ${label}`}>
      <Icon name="clock" size={12} color={expired ? colors.danger : colors.textTertiary} />
      <Text variant="overline" color={expired ? 'danger' : 'textTertiary'} style={styles.tabular}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.lg, padding: space.xl, borderRadius: radius.xl },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  flex: { flex: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
  amount: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: space.sm, paddingVertical: space.xs },
  unit: { marginBottom: space.xs },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 44,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  stack: { gap: space.sm },
  warning: {
    flexDirection: 'row',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.warningSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.warningBorder,
  },
  rowIcon: { marginTop: 1 },
  approval: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  worldTile: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceMuted,
  },
  reason: { gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  reasonHead: { flexDirection: 'row', gap: space.sm },
  reasonActions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  declined: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm, alignSelf: 'center' },
});
