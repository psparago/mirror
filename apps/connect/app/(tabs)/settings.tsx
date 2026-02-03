import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { VersionDisplay, useAuth } from '@projectmirror/shared';
import { db, doc, getDoc, serverTimestamp, setDoc } from '@projectmirror/shared/firebase';
import { Stack, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
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
  
  // 1. AUTH HOOK (For User ID & Logout)
  const { user, signOut } = useAuth(); 
  
  const [nameInput, setNameInput] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);

  // 2. LOAD FROM FIRESTORE (Robust Version)
  useFocusEffect(
    useCallback(() => {
      const loadProfile = async () => {
        if (!user?.uid) return;

        try {
          const userDoc = await getDoc(doc(db, 'users', user.uid));
          if (userDoc.exists()) {
            const data = userDoc.data();
            const cloudName = data?.companionName || data?.name || '';
            setNameInput(cloudName);
          }
        } catch (error) {
          console.error('Error loading profile:', error);
        } finally {
          setInitialLoad(false);
        }
      };

      loadProfile();
    }, [user?.uid])
  );

  // 3. SAVE TO FIRESTORE
  const saveCompanionName = async () => {
    const trimmedName = nameInput.trim();
    if (!trimmedName) {
      Alert.alert('Name Required', 'Please enter a name');
      return;
    }
    if (!user?.uid) return;

    setLoading(true);
    try {
      await setDoc(doc(db, 'users', user.uid), {
        companionName: trimmedName,
        updatedAt: serverTimestamp(),
        email: user.email,
        provider: user.providerData[0]?.providerId || 'anonymous',
      }, { merge: true });

      Alert.alert('Success', 'Companion name saved');
    } catch (error) {
      console.error('Error saving:', error);
      Alert.alert('Error', 'Failed to save name');
    } finally {
      setLoading(false);
    }
  };

  // 4. LOGOUT
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
              <Text style={styles.label}>Companion Name</Text>
              <Text style={styles.description}>
                This name will appear as the sender of your Reflections.
              </Text>
              
              {initialLoad ? (
                <ActivityIndicator style={{ padding: 20 }} />
              ) : (
                <>
                  <TextInput
                    style={styles.input}
                    placeholder="Enter your name (e.g., Emily, Auntie Tah)"
                    placeholderTextColor="#666"
                    value={nameInput}
                    onChangeText={setNameInput}
                    autoCapitalize="words"
                    editable={!loading}
                  />
                  <TouchableOpacity
                    style={[
                      styles.saveButton, 
                      (!nameInput.trim() || loading) && styles.saveButtonDisabled
                    ]}
                    onPress={saveCompanionName}
                    disabled={!nameInput.trim() || loading}
                  >
                    {loading ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.saveButtonText}>Save Name</Text>
                    )}
                  </TouchableOpacity>
                </>
              )}
            </View>
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

              {/* NEW: Provider Display */}
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Provider</Text>
                <Text style={styles.rowValue}>
                  {user?.providerData[0]?.providerId || 'Unknown'}
                </Text>
              </View>

              {/* NEW: User ID Display (Small font) */}
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
    backgroundColor: '#121212', // Dark background for Companion
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
    backgroundColor: '#1e1e1e', // Slightly lighter than background
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
    backgroundColor: '#2e78b7', // Nice Blue
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
  // Account Styles
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
    color: '#ff4d4d', // Red
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
});