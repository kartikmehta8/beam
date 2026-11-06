/**
 * @file Agents screen: connect an AI agent to Beam over hosted MCP (streamable
 * HTTP), the tools it gets, and the one rule: every agent payment needs this
 * human's World ID approval.
 *
 * Connecting is one command with a URL (`<server>/mcp/<wallet>`); no stdio, no
 * API key. World ID state is the same onchain signal Security uses.
 */
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { AgentAvatar } from '../src/components/AgentAvatar';
import { Icon } from '../src/components/Icon';
import { Screen } from '../src/components/Screen';
import { useCopy } from '../src/components/useCopy';
import { Card, ListRow, SectionHeader, Text, type IconName } from '../src/components/ui';
import { config } from '../src/config';
import { useBeamPayAccount, useWallet } from '../src/hooks';
import { colors, radius, space } from '../src/theme';

/** How each agent adds a streamable-HTTP MCP server, given the Beam MCP URL. */
const AGENTS: { id: string; label: string; command: (url: string) => string }[] = [
  { id: 'claude', label: 'Claude Code', command: (url) => `claude mcp add --transport http beam ${url}` },
  { id: 'codex', label: 'Codex', command: (url) => `codex mcp add beam --url ${url}` },
];

/** The tools Beam exposes to a connected agent. */
const TOOLS: { icon: IconName; title: string; subtitle: string }[] = [
  { icon: 'send', title: 'prepare_payment', subtitle: 'Propose a USDC payment you approve on your phone' },
  { icon: 'search', title: 'inspect_recipient', subtitle: 'Check a 0x address or ENS name before paying' },
  { icon: 'credit-card', title: 'get_wallet_balance', subtitle: 'Read your Arc USDC balance' },
  { icon: 'clock', title: 'get_tx_status', subtitle: "Check a payment's status" },
];

/**
 * Agents screen.
 * @returns The full-page screen, pushed from Profile.
 */
export default function AgentsScreen() {
  const { address } = useWallet();
  const account = useBeamPayAccount(address);
  const linked = account.value?.linked ?? false;
  const { copied, copy } = useCopy();
  const [agentId, setAgentId] = useState(AGENTS[0].id);
  const agent = AGENTS.find((a) => a.id === agentId) ?? AGENTS[0];

  const url = address ? `${config.agentUrl}/mcp/${address}` : null;
  const command = url ? agent.command(url) : 'Creating your wallet…';

  const header = (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back"
        hitSlop={space.md}
        onPress={() => router.back()}
        style={({ pressed }) => [styles.back, pressed && styles.pressed]}
      >
        <Icon name="chevron-left" size={24} color={colors.text} />
      </Pressable>
      <Text variant="headline">Agents</Text>
      <View style={styles.back} />
    </View>
  );

  return (
    <Screen header={header}>
      <View style={styles.section}>
        <SectionHeader title="Connect" />
        <Card style={styles.connect}>
          <View style={styles.tabs}>
            {AGENTS.map((a) => {
              const on = a.id === agentId;
              return (
                <Pressable
                  key={a.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={a.label}
                  onPress={() => setAgentId(a.id)}
                  style={({ pressed }) => [styles.tab, on && styles.tabOn, pressed && styles.pressed]}
                >
                  <AgentAvatar name={a.label} size={24} />
                  <Text variant="bodyStrong" color={on ? 'text' : 'textSecondary'} style={styles.flex} numberOfLines={1}>
                    {a.label}
                  </Text>
                  {on ? <Icon name="check-circle" size={18} color={colors.primary} /> : null}
                </Pressable>
              );
            })}
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copied ? 'Command copied' : `Copy ${agent.label} command`}
            disabled={!url}
            onPress={() => url && void copy(command)}
            style={({ pressed }) => [styles.terminal, pressed && styles.pressed]}
          >
            <View style={styles.terminalBar}>
              <View style={styles.dots}>
                <View style={[styles.dot, { backgroundColor: colors.danger }]} />
                <View style={[styles.dot, { backgroundColor: colors.warning }]} />
                <View style={[styles.dot, { backgroundColor: colors.success }]} />
              </View>
              <Icon name={copied ? 'check' : 'copy'} size={14} color={copied ? colors.success : colors.textTertiary} />
            </View>
            <View style={styles.cmd}>
              <Text variant="mono" color="textTertiary">
                {'$ '}
              </Text>
              <Text variant="mono" style={styles.flex}>
                {command}
              </Text>
            </View>
          </Pressable>

          <Text variant="caption" color="textTertiary">
            Hosted MCP over HTTP. No stdio, no API key.
          </Text>
        </Card>
      </View>

      <View style={styles.section}>
        <SectionHeader title="Tools" />
        <Card>
          {TOOLS.map((t, i) => (
            <ListRow key={t.title} icon={t.icon} tone="neutral" title={t.title} subtitle={t.subtitle} divider={i > 0} />
          ))}
        </Card>
      </View>

      <View style={styles.section}>
        <SectionHeader title="World ID" />
        <Card>
          <ListRow
            icon="shield"
            tone={linked ? 'success' : 'neutral'}
            title={linked ? 'World ID linked' : 'Set up World ID'}
            subtitle={linked ? 'Every agent payment needs your approval.' : 'Link once in Profile to approve agent payments.'}
            onPress={linked ? undefined : () => router.navigate('/profile')}
            trailing={linked ? <Icon name="check-circle" size={20} color={colors.success} /> : undefined}
          />
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    paddingHorizontal: space.xs,
    paddingBottom: space.sm,
  },
  back: { width: 40, height: 40, alignItems: 'flex-start', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  section: { gap: space.xs },
  connect: { gap: space.md },
  flex: { flex: 1 },
  tabs: { gap: space.sm },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  tabOn: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  terminal: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
    overflow: 'hidden',
  },
  terminalBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  dots: { flexDirection: 'row', gap: space.xs },
  dot: { width: 10, height: 10, borderRadius: 5 },
  cmd: { flexDirection: 'row', alignItems: 'flex-start', padding: space.md },
});
