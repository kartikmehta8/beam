/** Fixed, locally generated warning for instructions in untrusted context. */
import { StyleSheet, View } from 'react-native';
import { INJECTION_COPY, type InjectionSignal } from '../injection';
import { colors, radius, space } from '../theme';
import { Icon } from './Icon';
import { Text } from './ui';

export function InjectionWarning({ signals }: { signals: InjectionSignal[] }) {
  return (
    <View style={styles.warning} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <View style={styles.heading}>
        <Icon name="shield" size={18} color={colors.danger} />
        <Text variant="bodyStrong" color="danger" style={styles.text}>
          This screen contains instructions that may be trying to manipulate Beam. Payment from this screen has been blocked.
        </Text>
      </View>
      {signals.map((signal) => (
        <Text key={signal} variant="caption" color="textSecondary">{INJECTION_COPY[signal]}</Text>
      ))}
      <Text variant="caption" color="textSecondary">
        Review the captured text yourself. To pay, enter recipient and amount details you trust in the manual form.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  warning: { padding: space.lg, gap: space.sm, borderRadius: radius.lg, backgroundColor: colors.dangerSoft },
  heading: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  text: { flex: 1 },
});
