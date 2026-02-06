import { ExplorerConfig } from '@projectmirror/shared/explorer/ExplorerConfig';
import { auth, db } from '@projectmirror/shared/firebase';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import React, { createContext, useContext, useEffect, useState } from 'react';

interface ExplorerSelfContextType {
    explorerId: string | null;  // "PETER-08271957"
    explorerData: any | null;   // The full profile (name, preferences)
    loading: boolean;
}

const ExplorerSelfContext = createContext<ExplorerSelfContextType>({
    explorerId: null,
    explorerData: null,
    loading: true,
});

export function ExplorerSelfProvider({ children }: { children: React.ReactNode }) {
    const [explorerId, setExplorerId] = useState<string | null>(null);
    const [explorerData, setExplorerData] = useState<any | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const user = auth.currentUser;
        if (!user) {
            setLoading(false);
            return;
        }

        // Query: Find the explorer record linked to THIS anonymous device
        const q = query(
            collection(db, ExplorerConfig.collections.explorers),
            where('authorizedDevices', 'array-contains', user.uid)
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            if (!snapshot.empty) {
                // Found him!
                const doc = snapshot.docs[0];
                setExplorerId(doc.id);
                setExplorerData(doc.data());
                console.log(`✅ [ExplorerSelf] Identified as: ${doc.id}`);
            } else {
                console.warn(`⚠️ [ExplorerSelf] Device (UID: ${user.uid}) is not linked to an Explorer record.`);
                setExplorerId(null);
                setExplorerData(null);
            }
            setLoading(false);
        }, (err) => {
            console.error("Error identifying explorer:", err);
            setLoading(false);
        });

        return () => unsubscribe();
    }, []);

    return (
        <ExplorerSelfContext.Provider value={{ explorerId, explorerData, loading }}>
            {children}
        </ExplorerSelfContext.Provider>
    );
}

export const useExplorerSelf = () => useContext(ExplorerSelfContext);