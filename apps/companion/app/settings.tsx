import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { VersionDisplay } from '@projectmirror/shared';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stack, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

export default function SettingsScreen() {
    const colorScheme = useColorScheme();
    const tintColor = Colors[colorScheme ?? 'light'].tint;
    const [companionName, setCompanionName] = useState<string>('');
    const [nameInput, setNameInput] = useState<string>('');

    // Load companion name when screen is focused
    useFocusEffect(
        useCallback(() => {
            const loadName = async () => {
                try {
                    const storedName = await AsyncStorage.getItem('companion_name');
                    if (storedName) {
                        setCompanionName(storedName);
                        setNameInput(storedName);
                    } else {
                        setCompanionName('');
                        setNameInput('');
                    }
                } catch (error) {
                    console.error('Error loading companion name:', error);
                }
            };
            loadName();
        }, [])
    );

    const saveCompanionName = async () => {
        const trimmedName = nameInput.trim();
        if (!trimmedName) {
            Alert.alert('Name Required', 'Please enter a name');
            return;
        }
        try {
            await AsyncStorage.setItem('companion_name', trimmedName);
            setCompanionName(trimmedName);
            Alert.alert('Success', 'Companion name saved');
        } catch (error) {
            console.error('Error saving companion name:', error);
            Alert.alert('Error', 'Failed to save name');
        }
    };

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
                    <Text style={[styles.sectionTitle, { color: tintColor }]}>Identity</Text>
                    <View style={styles.card}>
                        <Text style={styles.label}>Companion Name</Text>
                        <Text style={styles.description}>
                            This name will appear as the sender of your Reflections.
                        </Text>
                        <TextInput
                            style={styles.input}
                            placeholder="Enter your name (e.g., Emily, Auntie Tah, Nona, Granddad)"
                            placeholderTextColor="#666"
                            value={nameInput}
                            onChangeText={setNameInput}
                            autoCapitalize="words"
                        />
                        <TouchableOpacity
                            style={[styles.saveButton, !nameInput.trim() && styles.saveButtonDisabled]}
                            onPress={saveCompanionName}
                            disabled={!nameInput.trim()}
                        >
                            <Text style={styles.saveButtonText}>Save</Text>
                        </TouchableOpacity>
                    </View>
                </View>

                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: tintColor }]}>App Information</Text>
                    <View style={styles.card}>
                        <VersionDisplay />
                    </View>
                </View>

                <View style={styles.footer}>
                    <Text style={styles.footerText}>Reflection Companion</Text>
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
    label: {
        fontSize: 16,
        fontWeight: '600',
        color: '#fff',
        marginBottom: 8,
    },
    description: {
        fontSize: 14,
        color: '#999',
        marginBottom: 16,
        lineHeight: 20,
    },
    input: {
        backgroundColor: 'rgba(255, 255, 255, 0.1)',
        borderRadius: 12,
        padding: 16,
        fontSize: 16,
        color: '#fff',
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.2)',
        marginBottom: 16,
    },
    saveButton: {
        backgroundColor: '#2e78b7',
        borderRadius: 12,
        paddingVertical: 14,
        paddingHorizontal: 24,
        alignItems: 'center',
    },
    saveButtonDisabled: {
        backgroundColor: '#444',
        opacity: 0.5,
    },
    saveButtonText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '600',
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

