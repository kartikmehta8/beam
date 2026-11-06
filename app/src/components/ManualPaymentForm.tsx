/** User-authored payment fields. The parent always opens this form empty. */
import { StyleSheet, TextInput, View } from 'react-native';
import { NETWORK } from '../config';
import { colors, radius, space, type as typeScale } from '../theme';
import { Button, Card, Text } from './ui';

type Props = {
  recipient: string;
  amount: string;
  busy: boolean;
  onRecipientChange: (value: string) => void;
  onAmountChange: (value: string) => void;
  onPrepare: () => void;
  onClose: () => void;
};

export function ManualPaymentForm({ recipient, amount, busy, onRecipientChange, onAmountChange, onPrepare, onClose }: Props) {
  return (
    <Card style={styles.form}>
      <Text variant="headline">Enter payment details</Text>
      <Text variant="caption" color="textSecondary">
        Enter a recipient and amount you have checked yourself. Screen text and chat suggestions are not used here.
      </Text>
      <View style={styles.fieldGroup}>
        <Text variant="captionStrong">Recipient</Text>
        <TextInput
          value={recipient}
          onChangeText={onRecipientChange}
          placeholder="Wallet address or ENS name"
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={255}
          accessibilityLabel="Manual payment recipient"
          style={styles.field}
        />
      </View>
      <View style={styles.fieldGroup}>
        <Text variant="captionStrong">Amount ({NETWORK.symbol})</Text>
        <TextInput
          value={amount}
          onChangeText={onAmountChange}
          placeholder="0.00"
          placeholderTextColor={colors.textTertiary}
          keyboardType="decimal-pad"
          maxLength={40}
          accessibilityLabel="Manual payment amount"
          style={styles.field}
        />
      </View>
      <Button label="Prepare manual payment" icon="send" disabled={!recipient.trim() || !amount.trim()} loading={busy} onPress={onPrepare} />
      <Button label="Close manual entry" variant="ghost" onPress={onClose} />
    </Card>
  );
}

const styles = StyleSheet.create({
  form: { gap: space.md },
  fieldGroup: { gap: space.xs },
  field: { ...typeScale.body, color: colors.text, minHeight: 48, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, paddingHorizontal: space.md },
});
