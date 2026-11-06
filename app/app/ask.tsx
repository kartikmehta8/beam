/**
 * @file Ask sheet: opened by the beam via `bubbleagent://ask?ctx=<id>`
 * over whatever app the user was in (the activity is translucent), and by an
 * external agent's payment link `bubbleagent://review?p=<base64url>`.
 *
 * On mount it consumes the screen context once (or decodes the review link),
 * gates on the Privy session and resumes any pending payment. A review link is
 * untrusted: a deliberate review tap rebuilds its payment locally (origin
 * `mcp`, so it always needs World ID approval). Messages inspect by default;
 * only explicit payment actions issue revocable local authorizations.
 * Dismissing (scrim, close, hardware back)
 * aborts the in-flight request, resets the stack to the Wallet tab and moves
 * the task to back.
 */
import { Icon } from '../src/components/Icon';
import type { NavigationProp, ParamListBase } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import { randomUUID } from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { router, useFocusEffect, useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BubbleOverlay } from '../modules/bubble-overlay';
import { planTurn, type AgentContext, type AgentErrorKind, type ChatTurn, type Clarification } from '../src/agentApi';
import { paymentLevel, type Assessment } from '../src/risk';
import { getReadAloud, paymentSpeech, speak, stopSpeaking, verdictSpeech } from '../src/voice';
import { decodeReviewLink, type ReviewLinkPayload } from '../src/api';
import { PendingBanner, SetupBanner } from '../src/components/Banner';
import { BeamGlyph, BrandMark } from '../src/components/BrandMark';
import { ContextChip, type CapturedContext, type ContextState } from '../src/components/ContextChip';
import { IntentCard } from '../src/components/IntentCard';
import { InjectionWarning } from '../src/components/InjectionWarning';
import { ManualPaymentForm } from '../src/components/ManualPaymentForm';
import { SafetyCard, SIGNAL_COPY } from '../src/components/RiskVerdict';
import { MessageBubble, NoticeRow, TypingIndicator } from '../src/components/MessageBubble';
import { NetworkPill } from '../src/components/NetworkPill';
import { SuggestionChip } from '../src/components/SuggestionChip';
import { Button, Text, type IconName } from '../src/components/ui';
import { chipLabel } from '../src/fallbackParser';
import { usePendingTx, useServerStatus, useWallet } from '../src/hooks';
import { isTransferError, type Intent } from '../src/intent';
import { getLimitState } from '../src/limits';
import { prepareOnDevice } from '../src/prepare';
import { NETWORK } from '../src/config';
import { scanInjection } from '../src/injection';
import {
  authorizePayment,
  createPaymentScope,
  revokePaymentScope,
  type PaymentAuthorization,
  type PaymentScope,
} from '../src/paymentAuthorization';
import { colors, HIT, radius, shadow, space, type as typeScale } from '../src/theme';

/** Same cap the screen reader applies; clipboard text is held to it too. */
const MAX_CONTEXT_CHARS = 4000;
const MAX_INPUT_CHARS = 500;
/** Visual size of the header close button; `hitSlop` pads it to a 48-pt target. */
const CLOSE = 36;

const QUICK_ACTIONS: { label: string; icon: IconName }[] = [
  { label: 'What is this address?', icon: 'search' },
  { label: 'My balance', icon: 'pie-chart' },
];

/** Icon for each reason the agent couldn't be used. */
const NOTICE_ICON: Record<AgentErrorKind, IconName> = {
  auth: 'lock',
  mismatch: 'alert-triangle',
  offline: 'wifi-off',
  'bad-response': 'wifi-off',
};

/** How an external agent's context is labelled on the device. */
const EXTERNAL_AGENT = 'External agent';

type Turn =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string; intents: Intent[]; authorizations: Record<string, PaymentAuthorization>; clarification: Clarification | null; assessment: Assessment | null }
  | { id: string; kind: 'notice'; text: string; tone: 'warning' | 'danger'; icon: IconName };

/** Prior chat remains readable, but every new action removes its executable cards. */
function withoutPayments(turns: Turn[]): Turn[] {
  return turns.map((turn) => turn.kind === 'assistant' ? { ...turn, intents: [], authorizations: {} } : turn);
}

/**
 * Runs a native call that may be missing (Expo Go, iOS) or throw.
 * @param fn The call.
 * @param fallback Value on failure.
 * @returns The call's result or the fallback.
 */
function tryNative<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Consumes the captured screen context. The native store returns it once, then deletes it.
 * @param ctxId `ctx` deep-link param.
 * @returns Chip state.
 */
function consumeContext(ctxId: string | undefined): ContextState {
  const captured = ctxId ? tryNative(() => BubbleOverlay?.consumeScreenContext(ctxId) ?? null, null) : null;
  if (!captured) {
    return { kind: 'unavailable', accessibilityOn: tryNative(() => BubbleOverlay?.isAccessibilityEnabled() ?? false, false) };
  }
  const appLabel = captured.appLabel || captured.packageName;
  if (!captured.text.trim()) return { kind: 'empty', appLabel };
  return {
    kind: 'captured',
    ctx: {
      source: 'screen',
      appLabel,
      packageName: captured.packageName,
      text: captured.text.slice(0, MAX_CONTEXT_CHARS),
      capturedAt: captured.capturedAt,
      truncated: captured.truncated || captured.text.length > MAX_CONTEXT_CHARS,
    },
  };
}

/**
 * Context chip state for an external agent's payment link.
 * @param payload Decoded link.
 * @returns A captured "clipboard" context labelled "External agent".
 */
function reviewContext(payload: ReviewLinkPayload): ContextState {
  return {
    kind: 'captured',
    ctx: { source: 'clipboard', appLabel: EXTERNAL_AGENT, text: payload.context, capturedAt: Date.now(), truncated: false },
  };
}

/**
 * Request-shaped context (drops UI-only fields so a strict server schema accepts it).
 * @param c Captured context.
 * @returns The `context` object of the agent request.
 */
function toAgentContext(c: CapturedContext): AgentContext {
  return {
    source: c.source,
    appLabel: c.appLabel,
    text: c.text,
    capturedAt: c.capturedAt,
    ...(c.packageName ? { packageName: c.packageName } : {}),
  };
}

/**
 * Chat history for the agent: user and assistant text only, no notices.
 * @param turns Sheet turns.
 * @returns Chat turns, oldest first.
 */
function toChat(turns: Turn[]): ChatTurn[] {
  return turns.flatMap((t): ChatTurn[] =>
    t.kind === 'user' ? [{ role: 'user', text: t.text }] : t.kind === 'assistant' && t.text ? [{ role: 'assistant', text: t.text }] : [],
  );
}

/**
 * Route component. Collapses the stack to this route so no opaque screen sits
 * under the sheet: on a warm start expo-router's linking dispatches a NAVIGATE
 * that pushes `ask` over `index`; on a cold start the state is already `[ask]`.
 * @returns The sheet, remounted per capture so a new tap starts a fresh session.
 */
/**
 * Text to read aloud for a new assistant turn: the payment, else the screen
 * verdict, else the reply. Speech never confirms; the fingerprint still does.
 * @param intent The turn's first payment, if any.
 * @param assessment The turn's Scam Shield verdict, if any.
 * @param reply The assistant reply text.
 * @returns What to speak, or null for nothing.
 */
function speakFor(intent: Intent | null, assessment: Assessment | null, reply: string): string | null {
  if (intent) return paymentSpeech(intent, paymentLevel(intent.warnings, assessment));
  if (assessment) return verdictSpeech(assessment, assessment.signals.map((sig) => SIGNAL_COPY[sig]));
  return reply || null;
}

export default function AskRoute() {
  const { ctx, p } = useLocalSearchParams<{ ctx?: string; p?: string }>();
  const navigation = useNavigation<NavigationProp<ParamListBase>>();

  useEffect(() => {
    const state = navigation.getState();
    if (state && state.routes.length > 1) navigation.reset({ ...state, index: 0, routes: [state.routes[state.index]] });
  }, [navigation]);

  const ctxId = typeof ctx === 'string' && ctx ? ctx : undefined;
  const review = typeof p === 'string' ? p : undefined;
  return <AskSheet key={review ?? ctxId ?? 'none'} ctxId={ctxId} review={review} />;
}

/**
 * The bottom sheet.
 * @param props.ctxId Screen-context ID from the beam's deep link.
 * @param props.review `p` of an external agent's review link, if opened by one.
 * @returns Scrim plus sheet.
 */
export function AskSheet({ ctxId, review, page = false }: { ctxId: string | undefined; review?: string; page?: boolean; inApp?: boolean }) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const { ready, user, wallet, address } = useWallet();
  const pending = usePendingTx();
  const server = useServerStatus();
  const [payload] = useState(() => (review === undefined ? null : decodeReviewLink(review)));
  const [context, setContext] = useState<ContextState>(() => (payload ? reviewContext(payload) : consumeContext(ctxId)));
  const [excluded, setExcluded] = useState(false);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualRecipient, setManualRecipient] = useState('');
  const [manualAmount, setManualAmount] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const scopeRef = useRef<PaymentScope | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);
  const progress = useRef(new Animated.Value(0)).current;
  const closing = useRef(false);

  // Synchronous revocation protects even an already-open biometric/approval dialog.
  const invalidate = useCallback(() => {
    generation.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    revokePaymentScope(scopeRef.current);
    scopeRef.current = null;
    setBusy(false);
    setTurns(withoutPayments);
    return generation.current;
  }, []);

  useEffect(() => {
    invalidate();
    return () => {
      generation.current += 1;
      abortRef.current?.abort();
      revokePaymentScope(scopeRef.current);
      stopSpeaking();
    };
  }, [address, invalidate]);

  const injection = scanInjection(context.kind === 'captured' ? context.ctx.text : '');

  useFocusEffect(useCallback(() => () => { invalidate(); }, [invalidate]));

  useEffect(() => {
    if (!page) Animated.spring(progress, { toValue: 1, damping: 26, stiffness: 260, overshootClamping: true, useNativeDriver: true }).start();
    return () => abortRef.current?.abort();
  }, [progress, page]);

  const dismiss = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    invalidate();
    stopSpeaking();
    Animated.timing(progress, { toValue: 0, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() => {
      router.replace('/');
      tryNative(() => BubbleOverlay?.minimizeApp(), undefined);
    });
  }, [progress, invalidate]);

  useEffect(() => {
    if (page) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      dismiss();
      return true;
    });
    return () => sub.remove();
  }, [dismiss, page]);

  // Voice input only edits the user's message; it grants no payment permission.
  const listenToInput = useCallback(async () => {
    const call = invalidate();
    try {
      const said = await BubbleOverlay?.listen();
      if (said && generation.current === call) setInput((prev) => (prev ? `${prev} ${said}` : said).slice(0, MAX_INPUT_CHARS));
    } catch {
      // Leave the message unchanged if no speech recognizer is available.
    }
  }, [invalidate]);

  const readClipboard = async () => {
    const call = invalidate();
    setClipboardError(null);
    const text = await Clipboard.hasStringAsync()
      .then((has) => (has ? Clipboard.getStringAsync() : ''))
      .catch(() => '');
    if (generation.current !== call) return;
    if (!text.trim()) {
      setClipboardError('Clipboard is empty.');
      return;
    }
    void Haptics.selectionAsync();
    setExcluded(false);
    // A new context starts a new conversation, so previous context-derived replies
    // and clarification options cannot be promoted into this payment request.
    setTurns([]);
    setContext({
      kind: 'captured',
      ctx: {
        source: 'clipboard',
        appLabel: 'Clipboard',
        text: text.slice(0, MAX_CONTEXT_CHARS),
        capturedAt: Date.now(),
        truncated: text.length > MAX_CONTEXT_CHARS,
      },
    });
  };

  const changeExcluded = (next: boolean) => {
    invalidate();
    setTurns([]);
    setExcluded(next);
  };

  const openManual = () => {
    invalidate();
    // These fields are always blank: neither model output nor captured text is
    // ever copied into the user-authored payment path.
    setManualRecipient('');
    setManualAmount('');
    setManualOpen(true);
  };

  const prepareDirect = async (external: boolean) => {
    if (!address || busy) return;
    if (external && (!payload || scanInjection(payload.context).suspected)) return;
    const recipient = manualRecipient.trim();
    const amount = manualAmount.trim();
    if (!external && (!recipient || !amount)) return;
    const call = invalidate();
    const scope = createPaymentScope(address);
    scopeRef.current = scope;
    setBusy(true);
    try {
      const limits = await getLimitState();
      if (generation.current !== call) return;
      const result = await prepareOnDevice(external && payload ? {
        id: payload.intentId,
        to: payload.to,
        amount: payload.amount,
        wallet: address,
        remainingWei: limits.remainingWei,
        context: { source: 'clipboard', appLabel: EXTERNAL_AGENT, text: payload.context },
        userTexts: [],
        parsedBy: 'agent',
        origin: 'mcp',
      } : {
        id: randomUUID(),
        to: recipient,
        amount,
        wallet: address,
        remainingWei: limits.remainingWei,
        context: null,
        userTexts: [`Send ${amount} ${NETWORK.symbol} to ${recipient}`],
        parsedBy: 'manual',
        origin: 'phone',
      });
      if (generation.current !== call || scopeRef.current !== scope) return;
      const turn: Turn = isTransferError(result)
        ? { id: randomUUID(), kind: 'notice', text: result.message, tone: 'danger', icon: 'alert-circle' }
        : {
            id: randomUUID(), kind: 'assistant',
            text: external ? 'An outside agent asked for this payment. Check every detail.' : 'Review the payment details you entered.',
            intents: [result], authorizations: { [result.id]: authorizePayment(scope, result) },
            clarification: null, assessment: null,
          };
      setTurns((previous) => [...previous, turn]);
    } catch {
      if (generation.current === call) {
        setTurns((previous) => [...previous, { id: randomUUID(), kind: 'notice', text: 'Could not prepare this payment. Check the details and try again.', tone: 'danger', icon: 'alert-circle' }]);
      }
    } finally {
      if (generation.current === call) setBusy(false);
    }
  };

  const send = async (raw: string, action: 'inspect' | 'pay' = 'inspect') => {
    const text = raw.trim();
    if (!text || busy || !address || (action === 'pay' && (injection.suspected || review !== undefined))) return;
    const call = invalidate();
    const scope = action === 'pay' ? createPaymentScope(address) : null;
    scopeRef.current = scope;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setInput('');
    const history: Turn[] = [...withoutPayments(turns), { id: randomUUID(), kind: 'user', text }];
    setTurns(history);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const limits = await getLimitState();
      if (generation.current !== call || controller.signal.aborted) return;
      const outcome = await planTurn({
        action,
        history: toChat(history),
        context: context.kind === 'captured' && !excluded ? toAgentContext(context.ctx) : null,
        wallet: address,
        limits,
        signal: controller.signal,
      });
      if (generation.current !== call || controller.signal.aborted) return;
      // Only this local explicit action can authorize cards, even if a server
      // response to an inspection unexpectedly includes payment proposals.
      const intents = scope ? outcome.intents : [];
      const authorizations = scope ? Object.fromEntries(intents.map((intent) => [intent.id, authorizePayment(scope, intent)])) : {};
      const added: Turn[] = [];
      if (outcome.notice) {
        const { kind, text, tone } = outcome.notice;
        added.push({ id: randomUUID(), kind: 'notice', text, tone, icon: NOTICE_ICON[kind] });
      }
      const reply = [...new Set([outcome.reply, outcome.clarification?.question ?? ''])].filter(Boolean).join('\n\n');
      if (reply || intents.length || outcome.assessment) {
        added.push({
          id: randomUUID(), kind: 'assistant', text: reply, intents, authorizations,
          clarification: outcome.clarification, assessment: outcome.assessment,
        });
        const spoken = speakFor(intents[0] ?? null, outcome.assessment, reply);
        if (spoken) void getReadAloud().then((on) => {
          if (on && generation.current === call) speak(spoken);
        });
      }
      setTurns((previous) => [...previous, ...added]);
    } catch {
      if (generation.current === call && !controller.signal.aborted) {
        setTurns((previous) => [...previous, { id: randomUUID(), kind: 'notice', text: 'Something went wrong. Try again.', tone: 'danger', icon: 'alert-circle' }]);
      }
    } finally {
      if (generation.current === call) {
        if (abortRef.current === controller) abortRef.current = null;
        setBusy(false);
      }
    }
  };

  const lastTurn = turns[turns.length - 1];
  const canSend = !!input.trim() && !busy;
  // A review card is tall; give the sheet more room once one is on screen.
  const hasIntent = turns.some((t) => t.kind === 'assistant' && t.intents.length > 0);

  let body: ReactNode;
  if (!ready || (user && !address)) {
    body = (
      <View style={styles.gate}>
        <ActivityIndicator color={colors.primary} />
        <Text variant="callout" color="textSecondary">
          {ready ? 'Setting up your wallet…' : 'Loading…'}
        </Text>
      </View>
    );
  } else if (!user || !address) {
    body = (
      <View style={styles.gate}>
        <BrandMark size={56} />
        <View style={styles.gateText}>
          <Text variant="title" align="center">
            Sign in to Beam first.
          </Text>
          <Text variant="callout" color="textSecondary" align="center">
            Sign in once with your email, then tap the beam in any app.
          </Text>
        </View>
        <Button label="Open Beam" icon="arrow-right" onPress={() => router.replace('/')} style={styles.gateButton} />
      </View>
    );
  } else {
    const empty = turns.length === 0 && review === undefined;
    const chips = (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        style={[styles.quickScroll, page && styles.quickScrollPage]}
        contentContainerStyle={styles.quick}
      >
        {QUICK_ACTIONS.map((a) => (
          <SuggestionChip key={a.label} label={a.label} icon={a.icon} onPress={() => void send(a.label)} />
        ))}
      </ScrollView>
    );
    body = (
      <>
        <ScrollView
          ref={scrollRef}
          style={page ? styles.scrollPage : styles.scroll}
          contentContainerStyle={[styles.scrollContent, page && empty && styles.pageEmpty]}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          <SetupBanner server={server} />
          <PendingBanner status={pending.status} onRecheck={() => void pending.recheck()} />
          {review !== undefined || (page && context.kind !== 'captured') ? null : (
            <ContextChip
              state={context}
              excluded={excluded}
              onExcludedChange={changeExcluded}
              onUseClipboard={() => void readClipboard()}
              clipboardError={clipboardError}
            />
          )}
          {injection.suspected ? <InjectionWarning signals={injection.signals} /> : null}
          {review !== undefined ? (
            payload ? (
              <View style={styles.paymentActions}>
                <Text variant="callout" color="textSecondary">
                  An outside agent requested a payment. Review it here before any payment details are prepared.
                </Text>
                <Button label="Review external payment" icon="shield" disabled={busy || injection.suspected} onPress={() => void prepareDirect(true)} />
              </View>
            ) : (
              <NoticeRow text="This payment link is invalid." tone="danger" icon="alert-octagon" />
            )
          ) : (
            <View style={styles.paymentActions}>
              <Text variant="caption" color="textSecondary">Messages inspect by default. Use Pay this or Prepare payment to review a payment before sending.</Text>
              <Button
                variant="secondary"
                label={context.kind === 'captured' && !excluded ? 'Pay this' : 'Prepare payment'}
                icon="send"
                disabled={busy || injection.suspected || manualOpen}
                onPress={() => void send(input.trim() ? `Pay this. ${input.trim()}` : 'Pay this', 'pay')}
              />
            </View>
          )}
          {manualOpen ? (
            <ManualPaymentForm
              recipient={manualRecipient}
              amount={manualAmount}
              busy={busy}
              onRecipientChange={(value) => { invalidate(); setManualRecipient(value); }}
              onAmountChange={(value) => { invalidate(); setManualAmount(value); }}
              onPrepare={() => void prepareDirect(false)}
              onClose={() => { invalidate(); setManualOpen(false); }}
            />
          ) : (
            <Button variant="ghost" label="Enter payment manually" icon="edit" onPress={openManual} />
          )}
          {empty && !page ? chips : null}
          {empty && page ? (
            <View style={styles.greeting}>
              <View style={styles.greetingBeam}>
                <BeamGlyph size={30} color={colors.textInverse} />
              </View>
              <Text variant="title" align="center">
                What can I help with?
              </Text>
              <Text variant="callout" color="textSecondary" align="center">
                Ask about your wallet, check a message, or pay someone on Arc. Nothing moves without your fingerprint.
              </Text>
            </View>
          ) : null}
          {turns.map((turn) => {
            if (turn.kind === 'user') return <MessageBubble key={turn.id} role="user" text={turn.text} />;
            if (turn.kind === 'notice') return <NoticeRow key={turn.id} text={turn.text} tone={turn.tone} icon={turn.icon} />;
            const showChips = turn === lastTurn && !busy && !!turn.clarification?.options.length;
            return (
              <View key={turn.id} style={styles.turn}>
                {turn.text ? <MessageBubble role="assistant" text={turn.text} /> : null}
                {turn.assessment ? <SafetyCard assessment={turn.assessment} /> : null}
                {turn.intents.map((intent) => (
                  <IntentCard
                    key={`${turn.id}:${intent.id}`}
                    intent={intent}
                    authorization={turn.authorizations[intent.id]}
                    wallet={wallet}
                    address={address}
                    onSettled={() => void pending.recheck()}
                  />
                ))}
                {showChips ? (
                  <View style={styles.chips}>
                    {turn.clarification?.options.map((option) => (
                      <SuggestionChip
                        key={option}
                        label={chipLabel(option)}
                        mono={option.startsWith('0x')}
                        accessibilityLabel={option}
                        onPress={() => void send(option)}
                      />
                    ))}
                  </View>
                ) : null}
              </View>
            );
          })}
          {busy ? <TypingIndicator /> : null}
        </ScrollView>

        {empty && page ? chips : null}
        <View
          style={page ? [styles.pageComposer, { marginBottom: insets.bottom + space.md }] : styles.composer}
        >
          {page ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Paste from clipboard"
              onPress={() => void readClipboard()}
              style={({ pressed }) => [styles.send, styles.micPage, pressed && styles.micPressed]}
            >
              <Icon name="plus" size={22} color={colors.text} />
            </Pressable>
          ) : null}
          <TextInput
            ref={inputRef}
            value={input}
            onChangeText={(value) => { invalidate(); setInput(value); }}
            placeholder={page ? 'Ask Beam to inspect' : 'Ask about this screen'}
            placeholderTextColor={colors.textTertiary}
            maxLength={MAX_INPUT_CHARS}
            returnKeyType="send"
            onSubmitEditing={() => void send(input)}
            accessibilityLabel="Message to Beam"
            multiline={page}
            style={page ? styles.pageInput : styles.input}
          />
          {!input.trim() && BubbleOverlay ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Speak instead of typing"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={() => void listenToInput()}
              style={({ pressed }) => [styles.send, page ? styles.micPage : styles.mic, pressed && styles.micPressed]}
            >
              <Icon name="mic" size={20} color={colors.text} />
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send"
              accessibilityState={{ disabled: !canSend, busy }}
              disabled={!canSend}
              onPress={() => void send(input)}
              style={({ pressed }) => [styles.send, pressed && styles.sendPressed, !canSend && styles.sendDisabled]}
            >
              <Icon name="arrow-up" size={20} color={canSend ? colors.textInverse : colors.textSecondary} />
            </Pressable>
          )}
        </View>
      </>
    );
  }

  if (page) {
    return (
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.page, { paddingTop: insets.top + space.xs }]}
      >
        <View style={styles.pageHeader}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to wallet"
            onPress={() => { invalidate(); router.navigate('/'); }}
            style={({ pressed }) => [styles.headerButton, pressed && styles.closePressed]}
          >
            <Icon name="chevron-left" size={24} color={colors.text} />
          </Pressable>
          <View style={styles.pageTitle}>
            <BrandMark size={24} />
            <Text variant="headline" accessibilityRole="header">
              Beam
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New chat"
            disabled={busy || turns.length === 0}
            onPress={() => {
              invalidate();
              stopSpeaking();
              setTurns([]);
              setInput('');
              setContext({ kind: 'unavailable', accessibilityOn: true });
              setExcluded(false);
              setManualOpen(false);
              setManualRecipient('');
              setManualAmount('');
            }}
            style={({ pressed }) => [styles.headerButton, pressed && styles.closePressed, turns.length === 0 && styles.headerButtonIdle]}
          >
            <Icon name="edit" size={22} color={colors.text} />
          </Pressable>
        </View>
        {body}
      </KeyboardAvoidingView>
    );
  }

  return (
    <View style={styles.root}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, { opacity: progress }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} accessibilityRole="button" accessibilityLabel="Close Beam" />
      </Animated.View>
      <KeyboardAvoidingView behavior="padding" style={styles.kav} pointerEvents="box-none">
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            {
              maxHeight: hasIntent ? '85%' : '75%',
              paddingBottom: insets.bottom + space.md,
              transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }) }],
            },
          ]}
        >
          <View style={styles.handle} />
          <View style={styles.header}>
            <BrandMark size={28} />
            <Text variant="headline" accessibilityRole="header">
              Beam
            </Text>
            <NetworkPill />
            <View style={styles.flex} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={(HIT - CLOSE) / 2}
              onPress={dismiss}
              style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
            >
              <Icon name="x" size={18} color={colors.textSecondary} />
            </Pressable>
          </View>
          {body}
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  paymentActions: { gap: space.sm },
  root: { flex: 1 },
  scrim: { backgroundColor: colors.scrim },
  page: { flex: 1, backgroundColor: colors.canvas },
  pageHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.sm, paddingBottom: space.sm },
  pageTitle: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm },
  headerButton: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill },
  headerButtonIdle: { opacity: 0.35 },
  scrollPage: { flexGrow: 1, flexShrink: 1 },
  pageEmpty: { flexGrow: 1, justifyContent: 'center' },
  greeting: { alignItems: 'center', gap: space.md, paddingHorizontal: space.lg },
  greetingBeam: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  quickScrollPage: { marginHorizontal: 0, marginBottom: space.md },
  pageComposer: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, paddingHorizontal: space.lg },
  pageInput: {
    ...typeScale.body,
    flex: 1,
    minHeight: HIT,
    maxHeight: 140,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
    borderRadius: radius.xl,
    backgroundColor: colors.surfaceMuted,
    color: colors.text,
  },
  micPage: { backgroundColor: colors.surfaceMuted },
  kav: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    flexShrink: 1,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    paddingTop: space.sm,
    ...shadow.sheet,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.borderStrong,
    marginBottom: space.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    paddingHorizontal: space.xl,
    paddingBottom: space.md,
  },
  flex: { flex: 1 },
  close: {
    width: CLOSE,
    height: CLOSE,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closePressed: { backgroundColor: colors.border },
  scroll: { flexGrow: 0, flexShrink: 1 },
  scrollContent: { paddingHorizontal: space.xl, paddingTop: space.xs, paddingBottom: space.lg, gap: space.md },
  quickScroll: { marginHorizontal: -space.xl, flexGrow: 0 },
  quick: { paddingHorizontal: space.xl, gap: space.sm },
  turn: { gap: space.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  input: {
    ...typeScale.body,
    flex: 1,
    minHeight: HIT,
    paddingHorizontal: space.xl,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted,
    color: colors.text,
  },
  send: {
    width: HIT,
    height: HIT,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendPressed: { backgroundColor: colors.primaryPressed },
  sendDisabled: { backgroundColor: colors.primarySoftBorder },
  mic: {
    width: HIT,
    height: HIT,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micPressed: { opacity: 0.6 },
  gate: { alignItems: 'center', gap: space.lg, paddingHorizontal: space.xxl, paddingTop: space.xl, paddingBottom: space.xxl },
  gateText: { alignItems: 'center', gap: space.sm },
  gateButton: { alignSelf: 'stretch', marginTop: space.sm },
});
