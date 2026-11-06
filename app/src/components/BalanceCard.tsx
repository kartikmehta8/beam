/**
 * @file Wallet tab balance card: flat white card with the balance ("$124.50
 * USDC" on Arc), the per-payment cap, a centered copyable address chip and four
 * quick actions (Receive, Copy, Faucet, Explorer). Receive opens the QR sheet.
 */
import { Icon } from './Icon';
import { useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import type { Address } from 'viem';
import { NETWORK } from '../config';
import { shortAddress } from '../intent';
import { useViewNetwork, viewAddressUrl } from '../viewNetwork';
import { colors, HIT, radius, space } from '../theme';
import { money, moneyParts } from './format';
import { EnsMark } from './logos';
import { ReceiveSheet } from './ReceiveSheet';
import { Card, Text, type IconName } from './ui';
import { useCopy } from './useCopy';

const ACTION_SIZE = 52;

/**
 * Round quick action with a label underneath.
 * @param props.icon Feather icon.
 * @param props.label Visible label.
 * @param props.a11yLabel Screen-reader label.
 * @param props.primary Purple fill for the lead action.
 * @param props.disabled Blocks presses.
 * @param props.onPress Press handler.
 * @returns The action button.
 */
function QuickAction({
  icon,
  label,
  a11yLabel,
  primary,
  disabled,
  onPress,
}: {
  icon: IconName;
  label: string;
  a11yLabel: string;
  primary?: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.action, disabled && styles.disabled]}
    >
      {({ pressed }) => (
        <>
          <View style={[styles.actionCircle, primary && styles.actionPrimary, pressed && styles.pressed]}>
            <Icon name={icon} size={20} color={primary ? colors.textInverse : colors.primary} />
          </View>
          <Text variant="captionStrong" numberOfLines={1}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

type Props = {
  address: Address | null;
  balance: bigint | null;
  balanceError: boolean;
  cap: bigint | null;
  handle: string | null | undefined;
};

/**
 * Balance card.
 * @param props.address Embedded wallet address; null while the wallet is being created.
 * @param props.balance Balance in wei; null until loaded.
 * @param props.balanceError Last balance fetch failed.
 * @param props.cap BeamPay per-payment cap in wei; null until loaded or without BeamPay.
 * @param props.handle Beam handle for the Receive sheet, if claimed.
 * @returns The card plus its Receive sheet.
 */
export function BalanceCard({ address, balance, balanceError, cap, handle }: Props) {
  const { copied, copy } = useCopy();
  const ens = useCopy();
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [view] = useViewNetwork();
  const copyAddress = () => address && void copy(address);
  const open = (url: string) => void Linking.openURL(url);
  const parts = balance !== null ? moneyParts(balance) : null;

  // The copyable address chip; `chipStyle` centers it alone, or sizes it to sit beside the ENS chip.
  const addressChip = (addr: Address, chipStyle: StyleProp<ViewStyle>) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? 'Address copied' : `Copy wallet address ${shortAddress(addr)}`}
      onPress={copyAddress}
      hitSlop={space.xs}
      style={({ pressed }) => [chipStyle, pressed && styles.pressed]}
    >
      <Text variant="mono" color="textSecondary" numberOfLines={1}>
        {copied ? 'Copied' : shortAddress(addr)}
      </Text>
      <Icon name={copied ? 'check' : 'copy'} size={14} color={copied ? colors.success : colors.textTertiary} />
    </Pressable>
  );

  return (
    <Card style={styles.card}>
      <View style={styles.top}>
        <Text variant="overline" color="textTertiary">
          Balance
        </Text>
        {parts ? (
          <View style={styles.balanceRow} accessible accessibilityLabel={`Balance ${parts.value} ${parts.unit}`}>
            <Text variant="display" numberOfLines={1} adjustsFontSizeToFit style={styles.balance}>
              {parts.value}
            </Text>
            <Text variant="headline" color="textSecondary">
              {parts.unit}
            </Text>
          </View>
        ) : balanceError ? null : (
          <View style={styles.placeholder} accessible accessibilityLabel="Balance loading" />
        )}
        {cap !== null ? (
          <Text variant="caption" color="textSecondary" accessibilityLabel={`Per payment cap ${money(cap)}`}>
            Per payment cap {money(cap)}
          </Text>
        ) : null}
        {balanceError ? (
          <View style={styles.inline} accessibilityLiveRegion="polite">
            <Icon name="alert-circle" size={14} color={colors.danger} />
            <Text variant="caption" color="danger" style={styles.flex}>
              {"Couldn't load your balance. Pull down to retry."}
            </Text>
          </View>
        ) : null}

        {address ? (
          handle ? (
            // ENS present: address on the left, ENS name on the right.
            <View style={styles.idRow}>
              {addressChip(address, styles.chipInline)}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={ens.copied ? 'ENS name copied' : `Copy your ENS name ${handle}`}
                onPress={() => void ens.copy(handle)}
                hitSlop={space.xs}
                style={({ pressed }) => [styles.chipInline, pressed && styles.pressed]}
              >
                <EnsMark size={14} />
                <Text variant="mono" color="textSecondary" numberOfLines={1} ellipsizeMode="middle" style={styles.chipText}>
                  {ens.copied ? 'Copied' : handle}
                </Text>
                <Icon name={ens.copied ? 'check' : 'copy'} size={14} color={ens.copied ? colors.success : colors.textTertiary} />
              </Pressable>
            </View>
          ) : (
            // No ENS: a single centered address chip.
            addressChip(address, styles.chip)
          )
        ) : (
          <View style={styles.chip}>
            <ActivityIndicator size="small" color={colors.textTertiary} />
            <Text variant="caption" color="textSecondary">
              Creating your wallet…
            </Text>
          </View>
        )}
      </View>

      <View style={styles.actions}>
        <QuickAction icon="arrow-down-left" label="Receive" a11yLabel={`Receive ${NETWORK.symbol}`} primary disabled={!address} onPress={() => setReceiveOpen(true)} />
        <QuickAction
          icon={copied ? 'check' : 'copy'}
          label={copied ? 'Copied' : 'Copy'}
          a11yLabel={copied ? 'Address copied' : 'Copy address'}
          disabled={!address}
          onPress={copyAddress}
        />
        <QuickAction
          icon="droplet"
          label="Faucet"
          a11yLabel={`Get testnet ${NETWORK.symbol} from the faucet`}
          disabled={!address || !view.faucetUrl}
          onPress={() => view.faucetUrl && open(view.faucetUrl)}
        />
        <QuickAction
          icon="external-link"
          label="Explorer"
          a11yLabel="View wallet on explorer"
          disabled={!address}
          onPress={() => address && open(viewAddressUrl(view, address))}
        />
      </View>

      {address ? <ReceiveSheet address={address} handle={handle} visible={receiveOpen} onClose={() => setReceiveOpen(false)} /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { padding: space.xl, gap: space.xl },
  top: { gap: space.sm, alignItems: 'flex-start' },
  flex: { flex: 1 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.sm, alignSelf: 'stretch' },
  balanceRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  balance: { flexShrink: 1 },
  placeholder: { width: 168, height: 46, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    gap: space.sm,
    minHeight: 40,
    minWidth: '62%',
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted,
  },
  idRow: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', gap: space.sm },
  chipInline: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    minHeight: 40,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted,
  },
  chipText: { flexShrink: 1 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  action: { alignItems: 'center', gap: space.sm, minWidth: HIT + space.lg },
  actionCircle: {
    width: ACTION_SIZE,
    height: ACTION_SIZE,
    borderRadius: ACTION_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primarySoft,
  },
  actionPrimary: { backgroundColor: colors.primary },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.4 },
});
