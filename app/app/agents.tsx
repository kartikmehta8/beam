/**
 * @file Agents screen: connect an AI agent to Beam over MCP, the tools it gets,
 * and the one rule — every agent payment needs this human's World ID approval.
 *
 * Beam's MCP is a local stdio server (`server`, name "beam"), so connecting is an
 * MCP config entry, not a URL or API key. World ID state is the same onchain
 * signal Security uses (`BeamPayAccount.linked`).
 */
import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon } from '../src/components/Icon';
import { Screen } from '../src/components/Screen';
import { useCopy } from '../src/components/useCopy';
import { Card, ListRow, SectionHeader, Text, type IconName } from '../src/components/ui';
import { useBeamPayAccount, useWallet } from '../src/hooks';
import { colors, radius, space } from '../src/theme';

/** Paste into an agent's MCP config (Claude Desktop, Cursor, Codex...). Beam's MCP is local stdio. */
const MCP_CONFIG = `{
  "mcpServers": {
    "beam": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "server"
    }
  }
}`;

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
      <Text variant="callout" color="textSecondary" style={styles.lede}>
        Connect an AI agent to Beam. It can propose payments; you approve each one with World ID, and USDC settles on Arc.
      </Text>

      <View style={styles.section}>
        <SectionHeader title="Works with" />
        <Card>
          <ListRow icon="cpu" tone="neutral" title="Any MCP client" subtitle="Claude, Claude Code, Cursor, Codex — anything that speaks MCP." />
        </Card>
      </View>

      <View style={styles.section}>
        <SectionHeader title="Connect" />
        <Card style={styles.connect}>
          <Text variant="caption" color="textSecondary">
            Add this to your agent’s MCP config. Beam’s MCP runs locally over stdio, so there is no URL or API key.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copied ? 'MCP config copied' : 'Copy MCP config'}
            onPress={() => void copy(MCP_CONFIG)}
            style={({ pressed }) => [styles.code, pressed && styles.pressed]}
          >
            <Text variant="mono" style={styles.codeText}>
              {MCP_CONFIG}
            </Text>
            <Icon name={copied ? 'check' : 'copy'} size={16} color={copied ? colors.success : colors.textTertiary} />
          </Pressable>
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
            subtitle={
              linked ? 'Every agent payment needs your approval here.' : 'Link once in Profile; then every agent payment needs your approval.'
            }
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
  lede: { marginTop: space.xs },
  section: { gap: space.xs },
  connect: { gap: space.sm },
  code: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceMuted,
  },
  codeText: { flex: 1 },
});
