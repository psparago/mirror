import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { VersionDisplay } from '@projectmirror/shared';
import { Stack } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

export default function SettingsScreen() {
    const colorScheme = useColorScheme();
    const tintColor = Colors[colorScheme ?? 'light'].tint;

    return (
        <View style={styles.container}>
            <Stack.Screen
                options={{
                    title: 'Settings',
                    headerBackTitle: 'Back',
                }}
            />
            <ScrollView contentContainerStyle={styles.scrollContent}>
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: tintColor }]}>App Information</Text>
                    <View style={styles.card}>
                        <VersionDisplay />
                    </View>
                </View>

                <View style={styles.footer}>
                    <Text style={styles.footerText}>Looking Glass Companion</Text>
                    <Text style={styles.footerSubtext}>by Angelware</Text>
                </View>
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#121212',
    },
    scrollContent: {
        padding: 16,
    },
    section: {
        marginBottom: 24,
    },
    sectionTitle: {
        fontSize: 14,
        fontWeight: 'bold',
        marginBottom: 8,
        marginLeft: 4,
        textTransform: 'uppercase',
        opacity: 0.8,
    },
    card: {
        backgroundColor: 'rgba(255, 255, 255, 0.05)',
        borderRadius: 16,
        padding: 16,
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.1)',
    },
    footer: {
        marginTop: 40,
        alignItems: 'center',
        opacity: 0.3,
    },
    footerText: {
        fontSize: 16,
        fontWeight: '600',
        color: '#fff',
    },
    footerSubtext: {
        fontSize: 12,
        color: '#fff',
        marginTop: 4,
    },
});

