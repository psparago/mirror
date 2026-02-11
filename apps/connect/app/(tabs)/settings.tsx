import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { VersionDisplay, useAuth, useExplorer } from '@projectmirror/shared';
import { db, doc, serverTimestamp, setDoc } from '@projectmirror/shared/firebase';
import { useRelationships } from '@projectmirror/shared/src/hooks/useRelationships';
import { Stack } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';

export default function SettingsScreen() {
  const colorScheme = useColorScheme();
  const tintColor = Colors[colorScheme ?? 'light'].tint;

  // AUTH
  const { user, signOut } = useAuth();

  // CONTEXT (The new Source of Truth)
  // We grab activeRelationship to know WHO we are naming ourselves for (e.g. Peter)
  const { activeRelationship, explorerName, loading: explorerLoading } = useExplorer();
  
  // We still fetch the full list for the "My Explorers" card at the bottom
  const { relationships, loading: relationshipsLoading } = useRelationships(user?.uid);

  const [nameInput, setNameInput] = useState<string>('');
  const [saving, setSaving] = useState(false);

  // 1. SYNC: Update the input box whenever the Active Relationship changes
  useEffect(() => {
    if (activeRelationship) {
      setNameInput(activeRelationship.companionName || '');
    } else {
      setNameInput(''); // Clear if no explorer selected
    }
  }, [activeRelationship?.id, activeRelationship?.companionName]);

  // 2. SAVE: Write to the Relationship Document (Not the User)
  const saveCompanionName = async () => {
    const trimmedName = nameInput.trim();
    if (!trimmedName) {
      Alert.alert('Name Required', 'Please enter a name');
      return;
    }
    
    // Safety check: Can't save a name if we don't have a relationship link
    if (!activeRelationship?.id) {
      Alert.alert('Error', 'No active explorer relationship found.');
      return;
    }

    setSaving(true);
    try {
      // ✅ Update the RELATIONSHIP record
      await setDoc(doc(db, 'relationships', activeRelationship.id), {
        companionName: trimmedName,
        updatedAt: serverTimestamp(),
      }, { merge: true });

      Alert.alert('Success', `Name updated for ${explorerName || activeRelationship.explorerId}`);
    } catch (error) {
      console.error('Error saving:', error);
      Alert.alert('Error', 'Failed to save name');
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut();
    } catch (error) {
      Alert.alert('Error', 'Failed to log out');
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

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.scrollContent}>

          {/* SECTION: IDENTITY */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: tintColor }]}>Identity</Text>
            
            <View style={styles.card}>
              {activeRelationship ? (
                <>
                  <Text style={styles.label}>
                    My Name for <Text style={{color: '#2e78b7'}}>{explorerName || activeRelationship.explorerId}</Text>
                  </Text>
                  <Text style={styles.description}>
                    This is how you will appear to this specific Explorer.
                  </Text>

                  <TextInput
                    style={styles.input}
                    placeholder="Enter your name (e.g., Dad, Uncle Mike)"
                    placeholderTextColor="#666"
                    value={nameInput}
                    onChangeText={setNameInput}
                    autoCapitalize="words"
                    editable={!saving}
                  />
                  <TouchableOpacity
                    style={[
                      styles.saveButton,
                      (!nameInput.trim() || saving) && styles.saveButtonDisabled
                    ]}
                    onPress={saveCompanionName}
                    disabled={!nameInput.trim() || saving}
                  >
                    {saving ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.saveButtonText}>Save Name</Text>
                    )}
                  </TouchableOpacity>
                </>
              ) : (
                <View style={{ padding: 10, alignItems: 'center' }}>
                  <Text style={{ color: '#888', fontStyle: 'italic' }}>
                    {explorerLoading ? "Loading explorer..." : "Link an Explorer to set your identity."}
                  </Text>
                </View>
              )}
            </View>
          </View>

          {/* SECTION: MY EXPLORERS */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: tintColor }]}>My Explorers</Text>

            {relationshipsLoading ? (
              <ActivityIndicator />
            ) : relationships.length === 0 ? (
              <Text style={styles.helperText}>No explorers linked yet.</Text>
            ) : (
              relationships.map((rel) => (
                <View key={rel.id} style={styles.explorerCard}>
                  <View style={styles.explorerCardRow}>
                    <Text style={styles.explorerCardLabel}>ID:</Text>
                    <Text style={styles.explorerCardValue}>{rel.explorerId}</Text>
                  </View>
                  <View style={styles.explorerCardRow}>
                    <Text style={styles.explorerCardLabel}>My Name:</Text>
                    <Text style={styles.explorerCardValue}>{rel.companionName}</Text>
                  </View>
                  <View style={styles.explorerCardRow}>
                    <Text style={styles.explorerCardLabel}>Role:</Text>
                    <Text style={styles.explorerCardValue}>{rel.role}</Text>
                  </View>
                  {activeRelationship?.id === rel.id && (
                     <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#333' }}>
                        <Text style={{ color: '#2e78b7', fontSize: 12, fontWeight: 'bold' }}>CURRENTLY SELECTED</Text>
                     </View>
                  )}
                </View>
              ))
            )}
          </View>

          {/* SECTION: ACCOUNT */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: tintColor }]}>Account</Text>
            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Signed in as</Text>
                <Text
                  style={[styles.rowValue, { flex: 1, textAlign: 'right', marginLeft: 16 }]}
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {user?.email || 'Unknown'}
                </Text>
              </View>

              <View style={styles.row}>
                <Text style={styles.rowLabel}>Provider</Text>
                <Text style={styles.rowValue}>
                  {user?.providerData[0]?.providerId || 'Unknown'}
                </Text>
              </View>

              <View style={styles.row}>
                <Text style={styles.rowLabel}>User ID</Text>
                <Text style={[styles.rowValue, { fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }]}>
                  {user?.uid}
                </Text>
              </View>

              <View style={styles.divider} />

              <TouchableOpacity
                style={styles.logoutButton}
                onPress={handleLogout}
              >
                <Text style={styles.logoutText}>Log Out</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* SECTION: INFO */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: tintColor }]}>App Information</Text>
            <View style={styles.card}>
              <VersionDisplay />
            </View>
          </View>

          <View style={styles.footer}>
            <Text style={styles.footerText}>Reflections Companion</Text>
            <Text style={styles.footerSubtext}>by Angelware</Text>
          </View>

        </ScrollView>
      </KeyboardAvoidingView>
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
    paddingBottom: 40,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
    marginLeft: 4,
    textTransform: 'uppercase',
    opacity: 0.7,
    letterSpacing: 0.5,
  },
  card: {
    backgroundColor: '#1e1e1e',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#333',
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
    marginBottom: 6,
  },
  description: {
    fontSize: 14,
    color: '#aaa',
    marginBottom: 16,
    lineHeight: 20,
  },
  input: {
    backgroundColor: '#2c2c2c',
    borderRadius: 8,
    padding: 14,
    fontSize: 16,
    color: '#fff',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#333',
  },
  saveButton: {
    backgroundColor: '#2e78b7',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  saveButtonDisabled: {
    backgroundColor: '#333',
    opacity: 0.7,
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  rowLabel: {
    fontSize: 16,
    color: '#fff',
  },
  rowValue: {
    fontSize: 16,
    color: '#aaa',
  },
  divider: {
    height: 1,
    backgroundColor: '#333',
    marginBottom: 16,
  },
  logoutButton: {
    alignItems: 'center',
    paddingVertical: 4,
  },
  logoutText: {
    color: '#ff4d4d',
    fontSize: 16,
    fontWeight: '600',
  },
  footer: {
    marginTop: 20,
    alignItems: 'center',
    opacity: 0.4,
  },
  footerText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  },
  footerSubtext: {
    fontSize: 12,
    color: '#fff',
    marginTop: 4,
  },
  explorerCard: {
    backgroundColor: '#1e1e1e',
    padding: 16,
    borderRadius: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#333',
  },
  explorerCardRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  explorerCardLabel: {
    color: '#fff',
    fontWeight: '500',
  },
  explorerCardValue: {
    fontWeight: '600',
    color: '#aaa',
  },
  helperText: {
    color: '#888',
    fontStyle: 'italic',
  }
});