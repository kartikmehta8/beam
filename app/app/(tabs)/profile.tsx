/**
 * @file Profile tab: account card (email and wallet address), Beam handle,
 * spending limits (onchain cap and daily limit), security (World ID), network
 * (chain ID and BeamPay contract) and about sections, and Sign out with a confirm.
 */
import { Icon } from '../../src/components/Icon';
import { usePrivy } from '@privy-io/expo';
import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, View } from 'react-native';
import { Avatar } from '../../src/components/Avatar';
import { pickAndUploadAvatar, useAvatarUri, type AvatarResult } from '../../src/avatar';
import { HandleRow, WorldIdRow } from '../../src/components/IdentityRows';
import { EnsMark } from '../../src/components/logos';
import { LimitsCard } from '../../src/components/LimitsCard';
import { NetworkPill } from '../../src/components/NetworkPill';
import { Screen } from '../../src/components/Screen';
import { Card, ListRow, SectionHeader, Text, Toggle, type IconName } from '../../src/components/ui';
import { useCopy } from '../../src/components/useCopy';
import { config, NETWORK } from '../../src/config';
import { shortAddress } from '../../src/intent';
import { addressUrl } from '../../src/network';
import { worldOf } from '../../src/serverApi';
import { colors, HIT, radius, space } from '../../src/theme';
import { useWalletData } from '../../src/walletData';
import { useReadAloud } from '../../src/voice';

type Row = { icon: IconName; title: string; subtitle?: string; onPress?: () => void; value?: string; badge?: ReactNode };

const open = (url: string) => void Linking.openURL(url);

/**
 * Titled card of list rows.
 * @param props.title Section name.
 * @param props.leading Custom rows above the plain ones (e.g. World ID).
 * @param props.rows Rows, top to bottom.
 * @returns Section header plus card.
 */
function Group({ title, leading, rows }: { title: string; leading?: ReactNode; rows: Row[] }) {
  return (
    <View>
      <SectionHeader title={title} />
      <Card style={styles.group}>
        {leading}
        {rows.map((row, i) => (
          <ListRow
            key={row.title}
            icon={row.icon}
            tone="neutral"
            title={row.title}
            subtitle={row.subtitle}
            divider={i > 0 || !!leading}
            onPress={row.onPress}
            trailing={
              row.badge ??
              (row.value ? (
                <Text variant="mono" color="textSecondary">
                  {row.value}
                </Text>
              ) : row.onPress ? (
                <Icon name="external-link" size={16} color={colors.textTertiary} />
              ) : undefined)
            }
          />
        ))}
      </Card>
    </View>
  );
}

/**
 * Profile screen.
 * @returns Account details and settings.
 */
export default function ProfileScreen() {
  const { logout } = usePrivy();
  const { address, email, limits, reloadLocal, account, accountError, reloadAccount, handle, handleError, reloadHandle, server } =
    useWalletData();
  const { beamPay } = config;
  const { copied, copy } = useCopy();
  const [readAloud, setReadAloud] = useReadAloud();
  const { uri: avatarUri, reload: reloadAvatar } = useAvatarUri(address);
  const [uploading, setUploading] = useState(false);

  const changeAvatar = async () => {
    if (!address || uploading) return;
    setUploading(true);
    const result = await pickAndUploadAvatar(address).catch((): AvatarResult => 'failed');
    setUploading(false);
    if (result === 'uploaded') reloadAvatar();
    else if (result === 'failed') Alert.alert('Upload failed', 'Could not upload the photo. Check your connection and try again.');
  };

  const confirmSignOut = () =>
    Alert.alert('Sign out?', 'Sign in again with the same email to get back to this wallet.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void logout() },
    ]);

  return (
    <Screen title="Profile">
      <Card style={styles.account}>
        <Pressable
          onPress={() => void changeAvatar()}
          disabled={!address || uploading}
          accessibilityRole="button"
          accessibilityLabel="Change profile photo"
          hitSlop={space.xs}
          style={({ pressed }) => [styles.avatarWrap, pressed && styles.pressed]}
        >
          <Avatar email={email} size={56} uri={avatarUri} />
          <View style={styles.avatarBadge}>
            {uploading ? <ActivityIndicator size="small" color={colors.textInverse} /> : <Icon name="camera" size={12} color={colors.textInverse} />}
          </View>
        </Pressable>
        <View style={styles.flex}>
          <Text variant="headline" numberOfLines={1} ellipsizeMode="middle">
            {email ?? 'Privy account'}
          </Text>
          <View style={styles.identity}>
            {address ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={copied ? 'Address copied' : `Copy wallet address ${shortAddress(address)}`}
                onPress={() => void copy(address)}
                hitSlop={space.sm}
                style={({ pressed }) => [styles.address, pressed && styles.pressed]}
              >
                <Text variant="mono" color="textSecondary">
                  {copied ? 'Copied' : shortAddress(address)}
                </Text>
                <Icon name={copied ? 'check' : 'copy'} size={14} color={copied ? colors.success : colors.textTertiary} />
              </Pressable>
            ) : (
              <Text variant="caption" color="textSecondary">
                Creating your wallet…
              </Text>
            )}
            {handle ? (
              <View style={styles.handleTag}>
                <EnsMark size={13} />
                <Text variant="mono" color="textSecondary" numberOfLines={1} ellipsizeMode="middle">
                  {handle}
                </Text>
              </View>
            ) : null}
          </View>
        </View>
      </Card>

      <View>
        <SectionHeader title="Your handle" />
        <Card style={styles.group}>
          <HandleRow
            address={address}
            handle={handle}
            handleError={handleError}
            account={account}
            server={server}
            onClaimed={() => void reloadHandle()}
          />
        </Card>
      </View>

      <View>
        <SectionHeader title="Security" />
        <Card style={styles.group}>
          <WorldIdRow address={address} account={account} accountError={accountError} server={server} onLinked={() => void reloadAccount()} />
        </Card>
      </View>

      <LimitsCard
        state={limits}
        address={address}
        account={account}
        world={worldOf(server)}
        onSaved={() => void reloadLocal()}
        onCapChanged={() => void reloadAccount()}
      />

      <Group
        title="Network"
        rows={[
          { icon: 'globe', title: 'Network', subtitle: `Chain ID ${NETWORK.chainId}`, badge: <NetworkPill /> },
          {
            icon: 'file-text',
            title: 'BeamPay contract',
            subtitle: beamPay ? shortAddress(beamPay) : 'Not deployed for this network yet',
            onPress: beamPay ? () => open(addressUrl(NETWORK, beamPay)) : undefined,
          },
          {
            icon: 'search',
            title: 'Explorer',
            subtitle: 'View your wallet on the explorer',
            onPress: () => open(address ? addressUrl(NETWORK, address) : NETWORK.explorerUrl),
          },
          { icon: 'droplet', title: 'Faucet', subtitle: `Get free testnet ${NETWORK.symbol}`, onPress: () => open(NETWORK.faucetUrl) },
        ]}
      />

      <View style={styles.group}>
        <SectionHeader title="Agents" />
        <Card>
          <ListRow
            icon="cpu"
            tone="neutral"
            title="Connected agents"
            subtitle="Let AI agents request payments you approve on your phone"
            onPress={() => router.push('/agents')}
          />
        </Card>
      </View>

      <View style={styles.group}>
        <SectionHeader title="Preferences" />
        <Card>
          <ListRow
            icon="volume-2"
            title="Read aloud"
            subtitle="Speak payments and safety verdicts"
            trailing={<Toggle value={readAloud} onValueChange={setReadAloud} label="Read aloud" />}
          />
        </Card>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sign out"
        onPress={confirmSignOut}
        style={({ pressed }) => [styles.signOut, pressed && styles.signOutPressed]}
      >
        <Icon name="log-out" size={18} color={colors.danger} />
        <Text variant="bodyStrong" color="danger">
          Sign out
        </Text>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, gap: space.xs },
  account: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  avatarWrap: { position: 'relative' },
  avatarBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.surface,
  },
  identity: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  address: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  handleTag: { flexDirection: 'row', alignItems: 'center', gap: space.xs, flexShrink: 1 },
  pressed: { opacity: 0.6 },
  group: { paddingVertical: space.xs },
  signOut: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    minHeight: HIT + space.sm,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  signOutPressed: { backgroundColor: colors.dangerSoft },
});
