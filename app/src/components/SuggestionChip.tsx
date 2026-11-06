/**
 * @file Outlined suggestion chip for the Ask sheet: quick actions before the
 * first message and clarification options from the agent.
 */
import { Icon } from './Icon';
import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet, View } from 'react-native';
import { colors, HIT, radius, space } from '../theme';
import { Text, type IconName } from './ui';

/**
 * Tappable suggestion. Shows a lavender border and tint while pressed.
 * @param props.label Visible label.
 * @param props.icon Optional leading icon (in a soft purple circle).
 * @param props.mono Render the label in monospace (addresses).
 * @param props.accessibilityLabel Spoken label when it differs from `label` (e.g. the full address).
 * @param props.onPress Sends the suggestion.
 * @returns A pill-shaped button with a 48-pt touch target.
 */
export function SuggestionChip({
  label,
  icon,
  mono,
  accessibilityLabel,
  disabled,
  onPress,
}: {
  label: string;
  icon?: IconName;
  mono?: boolean;
  accessibilityLabel?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      hitSlop={{ top: 4, bottom: 4 }}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [styles.chip, icon && styles.withIcon, pressed && styles.pressed, disabled && styles.disabled]}
    >
      {icon ? (
        <View style={styles.icon}>
          <Icon name={icon} size={14} color={colors.primary} />
        </View>
      ) : null}
      <Text variant={mono ? 'mono' : 'captionStrong'} numberOfLines={1} style={styles.label}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: HIT - 8,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  label: { flexShrink: 1 },
  withIcon: { paddingLeft: space.xs + 2 },
  pressed: { borderColor: colors.primarySoftBorder, backgroundColor: colors.primarySoft },
  disabled: { opacity: 0.4 },
  icon: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
