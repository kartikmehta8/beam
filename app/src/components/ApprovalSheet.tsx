/**
 * @file World ID approval sheet. Opening it starts an approval on the server;
 * the user verifies in World App ("Open World App"), or from another device
 * with the QR code or the copied link (how staging is tested with the World
 * ID simulator). The sheet polls until the server signs, then shows how it
 * ended. One primary action per state.
 */
import { Icon } from './Icon';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, View } from 'react-native';
import QRCodeStyled from 'react-native-qrcode-styled';
import type { ApprovalRequest } from '../api';
import type { ApprovalOutcome } from '../approvals';
import { useApprovalFlow, useServerStatus, type ApprovalPhase } from '../hooks';
import { worldOf } from '../serverApi';
import { colors, radius, space } from '../theme';
import { WorldMark } from './logos';
import { Sheet } from './Sheet';
import { Button, Text, type IconName, type Tone } from './ui';
import { useCopy } from './useCopy';

const BADGE = 56;
/** Edge of the approval QR in dp; modules scale to fit whatever the link's length. */
const QR_SIZE = 200;
const SIMULATOR_URL = 'https://simulator.worldcoin.org';

type Props = {
  visible: boolean;
  /** What to approve; built by the caller from the intent, cap or wallet. */
  request: ApprovalRequest | null;
  /** Sheet title, e.g. "World ID approval needed". */
  title: string;
  /** What exactly is being approved, in plain words. */
  detail: string;
  /** Use "Nothing was sent." (payments) instead of "Nothing changed." when cancelled. */
  payment?: boolean;
  /** Receives the approval as soon as the server signs it. */
  onApproved: (outcome: Extract<ApprovalOutcome, { kind: 'approved' }>) => void;
  onClose: () => void;
};

type EndPhase = Exclude<ApprovalPhase, { kind: 'starting' } | { kind: 'waiting' }>;
type EndTone = Extract<Tone, 'success' | 'warning' | 'danger'>;

/**
 * Title and badge for a finished approval.
 * @param phase How it ended.
 * @param payment Whether it was a payment (cancel copy).
 * @returns What to render.
 */
function describeEnd(phase: EndPhase, payment: boolean): { title: string; icon: IconName; tone: EndTone } {
  switch (phase.kind) {
    case 'approved':
      return { title: 'Approved by you on World ID', icon: 'check', tone: 'success' };
    case 'cancelled':
      return { title: `Approval cancelled. ${payment ? 'Nothing was sent.' : 'Nothing changed.'}`, icon: 'x', tone: 'warning' };
    case 'expired':
      return { title: 'Approval expired. Try again.', icon: 'clock', tone: 'warning' };
    case 'mismatch':
      return { title: "This World ID isn't linked to this wallet.", icon: 'user-x', tone: 'danger' };
    case 'error':
      return { title: phase.message, icon: 'alert-circle', tone: 'danger' };
  }
}

const BADGE_BG: Record<EndTone, string> = { success: colors.successSoft, warning: colors.warningSoft, danger: colors.dangerSoft };

/**
 * The approval sheet. Starts a fresh approval each time it opens; closing it
 * stops polling.
 * @param props See `Props`.
 * @returns A bottom sheet.
 */
export function ApprovalSheet({ visible, request, title, detail, payment = false, onApproved, onClose }: Props) {
  const { phase, retry } = useApprovalFlow(request, visible, (outcome) => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onApproved(outcome);
  });

  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      {phase.kind === 'starting' ? (
        <View style={styles.body} accessibilityLiveRegion="polite">
          <View style={[styles.badge, styles.neutral]}>
            <ActivityIndicator color={colors.primary} />
          </View>
          <Text variant="headline" align="center">
            Preparing your approval…
          </Text>
        </View>
      ) : phase.kind === 'waiting' ? (
        <Waiting key={phase.start.approvalId} connectUrl={phase.start.connectUrl} detail={detail} />
      ) : (
        <Ended phase={phase} payment={payment} onRetry={retry} onClose={onClose} />
      )}
    </Sheet>
  );
}

/**
 * Waiting for the proof: what is being approved, the steps, and the ways to
 * verify (World App here, or QR code and link for another device).
 * @param props.connectUrl IDKit connect link of this approval.
 * @param props.detail What is being approved.
 * @returns The waiting state.
 */
function Waiting({ connectUrl, detail }: { connectUrl: string; detail: string }) {
  const server = useServerStatus();
  const staging = worldOf(server) === 'staging';
  const [qr, setQr] = useState(false);
  const { copied, copy } = useCopy();
  // Other-device options lead in staging, where the simulator does the verifying.
  const other = staging ? 'primary' : 'secondary';

  const openWorld = (
    <Button
      key="world"
      variant={staging ? 'secondary' : 'primary'}
      label="Open World App"
      leading={<WorldMark size={18} color={staging ? colors.brandWorld : colors.textInverse} />}
      onPress={() => void Linking.openURL(connectUrl)}
    />
  );
  const verifySim = (
    <Button
      key="sim"
      variant="primary"
      label="Verify"
      leading={<WorldMark size={18} color={colors.textInverse} />}
      onPress={() => {
        void copy(connectUrl);
        void Linking.openURL(SIMULATOR_URL);
      }}
    />
  );
  const elsewhere = (
    <View key="elsewhere" style={styles.row}>
      <Button
        variant={other}
        size="sm"
        icon={qr ? 'list' : 'grid'}
        label={qr ? 'Show steps' : 'Show QR code'}
        onPress={() => setQr((v) => !v)}
        style={styles.flex}
      />
      <Button
        variant={other}
        size="sm"
        icon={copied ? 'check' : 'copy'}
        label={copied ? 'Copied' : 'Copy link'}
        accessibilityLabel={copied ? 'Approval link copied' : 'Copy approval link'}
        onPress={() => void copy(connectUrl)}
        style={styles.flex}
      />
    </View>
  );

  return (
    <>
      <View style={styles.body}>
        <WorldMark size={40} color={colors.brandWorld} />
        <View style={styles.text} accessibilityLiveRegion="polite">
          <Text variant="headline" align="center">
            Waiting for World ID
          </Text>
          <Text variant="caption" color="textSecondary" align="center">
            {staging ? 'Paste the copied link in the simulator, then Verify.' : 'Approve in your World App.'}
          </Text>
        </View>
        {qr ? (
          <View style={styles.qrFrame} accessible accessibilityRole="image" accessibilityLabel="QR code of the World ID approval link">
            <ApprovalQr data={connectUrl} />
          </View>
        ) : null}
      </View>
      <View style={styles.actions}>{staging ? [elsewhere, verifySim] : [openWorld, elsewhere]}</View>
    </>
  );
}

/**
 * QR code of the connect link, scaled to `QR_SIZE` whatever its module count.
 * @param props.data The link.
 * @returns The QR code.
 */
function ApprovalQr({ data }: { data: string }) {
  const [modules, setModules] = useState(0);
  const piece = modules ? QR_SIZE / modules : 0;
  return (
    <View style={styles.qr}>
      <QRCodeStyled
        data={data}
        pieceSize={piece}
        pieceBorderRadius={piece / 3}
        isPiecesGlued
        color={colors.ink}
        outerEyesOptions={{ borderRadius: piece * 2, color: colors.primary }}
        innerEyesOptions={{ borderRadius: piece, color: colors.ink }}
        onChangeSize={setModules}
      />
    </View>
  );
}

/**
 * How the approval ended, with Continue (approved) or Try again.
 * @param props.phase The end state.
 * @param props.payment Whether it was a payment (cancel copy).
 * @param props.onRetry Starts a new approval.
 * @param props.onClose Closes the sheet.
 * @returns The end state.
 */
function Ended({ phase, payment, onRetry, onClose }: { phase: EndPhase; payment: boolean; onRetry: () => void; onClose: () => void }) {
  const view = describeEnd(phase, payment);
  return (
    <>
      <View style={styles.body} accessibilityLiveRegion="polite">
        <View style={[styles.badge, { backgroundColor: BADGE_BG[view.tone] }]}>
          <Icon name={view.icon} size={26} color={colors[view.tone]} />
        </View>
        <Text variant="headline" align="center">
          {view.title}
        </Text>
      </View>
      {phase.kind === 'approved' ? (
        <Button label="Continue" icon="arrow-right" onPress={onClose} />
      ) : (
        <Button label="Try again" leading={<WorldMark size={18} color={colors.textInverse} />} onPress={onRetry} />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  body: { alignItems: 'center', gap: space.lg, paddingVertical: space.sm },
  badge: { width: BADGE, height: BADGE, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  neutral: { backgroundColor: colors.surfaceMuted },
  text: { alignItems: 'center', gap: space.xs },
  note: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.warningBorder,
    backgroundColor: colors.warningSoft,
  },
  notePressed: { opacity: 0.7 },
  steps: { alignSelf: 'stretch', gap: space.md },
  step: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  stepNum: {
    width: 24,
    height: 24,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primarySoft,
  },
  qrFrame: {
    padding: space.lg,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  qr: { width: QR_SIZE, height: QR_SIZE },
  actions: { gap: space.md },
  row: { flexDirection: 'row', gap: space.md },
  flex: { flex: 1 },
});
