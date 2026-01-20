import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { VersionDisplay } from '@projectmirror/shared';
import { Stack, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

export default function SettingsScreen() {
    const colorScheme = useColorScheme();
    const tintColor = Colors[colorScheme ?? 'light'].tint;
    const router = useRouter();

    return (
        <View style={styles.container}>
            <Stack.Screen
                options={{
                    title: 'System Information',
                    headerShown: true,
                    headerBackTitle: 'Back',
                    headerStyle: {
                        backgroundColor: '#0f2027',
                    },
                    headerTintColor: '#fff',
                    headerTitleStyle: {
                        fontWeight: 'bold',
                    },
                }}
            />

            <ScrollView contentContainerStyle={styles.scrollContent}>
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: tintColor }]}>Device & Build</Text>
                    <View style={styles.card}>
                        <VersionDisplay />
                    </View>
                </View>

                <TouchableOpacity
                    style={styles.backButton}
                    onPress={() => router.back()}
                >
                    <Text style={styles.backButtonText}>Exit System Info</Text>
                </TouchableOpacity>

                <View style={styles.footer}>
                    <Text style={styles.footerText}>Looking Glass</Text>
                    <Text style={styles.footerSubtext}>by Angelware</Text>
                </View>
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#0f2027', // Match LG dark theme
    },
    scrollContent: {
        padding: 32,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100%',
    },
    section: {
        marginBottom: 32,
        width: '100%',
        maxWidth: 500,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        marginBottom: 16,
        marginLeft: 4,
        textTransform: 'uppercase',
        color: '#fff',
        textAlign: 'center',
    },
    card: {
        backgroundColor: 'rgba(255, 255, 255, 0.1)',
        borderRadius: 24,
        padding: 32,
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.2)',
    },
    backButton: {
        backgroundColor: 'rgba(255, 255, 255, 0.2)',
        paddingVertical: 16,
        paddingHorizontal: 32,
        borderRadius: 30,
        marginTop: 20,
    },
    backButtonText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: 'bold',
    },
    footer: {
        marginTop: 60,
        alignItems: 'center',
        opacity: 0.5,
    },
    footerText: {
        fontSize: 16,
        fontWeight: '600',
        color: '#fff',
    },
    footerSubtext: {
        fontSize: 12,
        color: '#ccc',
        marginTop: 4,
    },
});
