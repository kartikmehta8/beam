/**
 * @file Beam tab "Access" checklist.
 *
 * Progress header, one row per permission with a tinted icon and either a
 * green check or an Allow/Fix button, and a collapsible restricted-settings
 * hint. Collapses to one "All set" row once everything is granted. Overlay is
 * required; the rest are recommended. Also exports the OEM autostart tip.
 */
import { Icon } from './Icon';
import { useState, type ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { BubbleOverlay } from '../../modules/bubble-overlay';
import { fixPermission, type PermissionKey, type PermissionStatus } from '../permissions';
import { colors, HIT, radius, space } from '../theme';
import { Button, Card, ListRow, ProgressBar, SectionHeader, Text, type IconName } from './ui';

type RowSpec = {
  key: PermissionKey;
  icon: IconName;
  title: string;
  granted: string;
  missing: string;
  /** Required rows use a primary button and red tint when missing; recommended ones secondary and amber. */
  required: boolean;
  action: string;
};

const ROWS: RowSpec[] = [
  {
    key: 'overlay',
    icon: 'layers',
    title: 'Display over other apps',
    granted: 'The beam can float over other apps',
    missing: 'Required to show the beam',
    required: true,
    action: 'Allow',
  },
  {
    key: 'accessibility',
    icon: 'eye',
    title: 'Screen reader',
    granted: 'Reads the screen only when you tap the beam',
    missing: 'Recommended. Turn on Beam screen reader in Accessibility',
    required: false,
    action: 'Fix',
  },
  {
    key: 'notifications',
    icon: 'bell',
    title: 'Notifications',
    granted: "Shows the beam's status notification",
    missing: "Needed for the beam's status notification",
    required: false,
    action: 'Allow',
  },
];

const OEM_TIP =
  "Enable Autostart and 'Display pop-up windows while running in background' in App info → Other permissions.";

/**
 * Subtle expandable info row.
 * @param props.label Always-visible question.
 * @param props.children Revealed content.
 * @returns The disclosure.
 */
function Hint({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.hint}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={label}
        onPress={() => setOpen((o) => !o)}
        style={({ pressed }) => [styles.hintToggle, pressed && styles.pressed]}
      >
        <Icon name="info" size={14} color={colors.textTertiary} />
        <Text variant="captionStrong" color="textSecondary" style={styles.flex}>
          {label}
        </Text>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textTertiary} />
      </Pressable>
      {open ? <View style={styles.hintBody}>{children}</View> : null}
    </View>
  );
}

/**
 * Collapsible autostart tip for OEM skins that kill background services.
 * @returns The disclosure row.
 */
export function OemTip() {
  return (
    <Hint label="Xiaomi, Redmi, POCO, Realme, Oppo or Vivo?">
      <Text variant="caption" color="textSecondary">
        {OEM_TIP}
      </Text>
    </Hint>
  );
}

/**
 * Checks whether a permission is satisfied; rows that don't apply count as granted.
 * @param status Current snapshot.
 * @param key Permission.
 * @returns True if granted or not applicable.
 */
function isGranted(status: PermissionStatus, key: PermissionKey): boolean {
  return status[key] ?? true;
}

/**
 * Setup section. Shows an explanatory row when the native module is
 * unavailable (iOS, Expo Go).
 * @param props.status Permission snapshot; null while loading.
 * @param props.refresh Re-reads the snapshot (after a fix flow returns).
 * @returns The section, or null while the first status read is in flight.
 */
export function PermissionsCard({ status, refresh }: { status: PermissionStatus | null; refresh: () => void }) {
  const [expanded, setExpanded] = useState(false);

  if (!BubbleOverlay) {
    return (
      <View>
        <SectionHeader title="Access" />
        <Card style={styles.card}>
          <ListRow
            icon="smartphone"
            tone="neutral"
            title="Android build required"
            subtitle="The beam and its permissions need the Beam Android app, not Expo Go."
          />
        </Card>
      </View>
    );
  }
  if (!status) return null;

  const rows = ROWS.filter((row) => status[row.key] !== null);
  const ready = rows.filter((row) => isGranted(status, row.key)).length;
  const allSet = ready === rows.length;
  const accessibilityMissing = !isGranted(status, 'accessibility');

  const summary = (
    <ListRow
      icon="check-circle"
      tone="success"
      title="All set"
      subtitle="The beam has everything it needs"
      accessibilityLabel={expanded ? 'All set. Hide permissions' : 'All set. Show permissions'}
      onPress={() => setExpanded((e) => !e)}
      trailing={<Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textTertiary} />}
    />
  );

  return (
    <View>
      <SectionHeader title="Access" meta={`${ready} of ${rows.length} ready`} />
      <Card style={styles.card}>
        {allSet ? (
          summary
        ) : (
          <View style={styles.progress}>
            <ProgressBar value={ready / rows.length} tone="primary" />
          </View>
        )}
        {!allSet || expanded
          ? rows.map((row, i) => {
              const granted = isGranted(status, row.key);
              return (
                <ListRow
                  key={row.key}
                  icon={row.icon}
                  tone={granted ? 'primary' : row.required ? 'danger' : 'warning'}
                  title={row.title}
                  subtitle={granted ? row.granted : row.missing}
                  divider={allSet || i > 0}
                  accessibilityLabel={`${row.title}. ${granted ? 'Granted' : row.missing}`}
                  trailing={
                    granted ? (
                      <Icon name="check-circle" size={20} color={colors.success} accessibilityLabel="Granted" />
                    ) : (
                      <Button
                        label={row.action}
                        accessibilityLabel={`${row.action} ${row.title}`}
                        size="sm"
                        variant={row.required ? 'primary' : 'secondary'}
                        onPress={() => void fixPermission(row.key).then(refresh)}
                      />
                    )
                  }
                />
              );
            })
          : null}
        {accessibilityMissing ? (
          <View style={styles.hints}>
            <Hint label="Screen reader switch greyed out?">
              <Text variant="caption" color="textSecondary">
                Android restricts it for apps installed from a file. Open App info, tap ⋮, then Allow restricted settings.
              </Text>
              <Pressable
                accessibilityRole="link"
                accessibilityLabel="Open App info"
                hitSlop={space.md}
                onPress={() => void Linking.openSettings()}
              >
                <Text variant="button" color="primary">
                  Open App info
                </Text>
              </Pressable>
            </Hint>
          </View>
        ) : null}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: space.sm, gap: 0 },
  flex: { flex: 1 },
  pressed: { opacity: 0.6 },
  progress: { paddingTop: space.md, paddingBottom: space.xs },
  hints: { paddingVertical: space.xs },
  hint: { borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  hintToggle: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: HIT, paddingHorizontal: space.md },
  hintBody: { gap: space.sm, paddingHorizontal: space.md, paddingBottom: space.md, alignItems: 'flex-start' },
});
