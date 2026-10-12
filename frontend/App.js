import React, { useState } from 'react';
import {
    View, Text, StyleSheet, TouchableOpacity, ScrollView,
    TextInput, ActivityIndicator, Alert, Platform
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { StatusBar } from 'expo-status-bar';

// Server switch: pick which backend the app talks to.
// 'local' = your PC on the home Wi-Fi  |  'cloud' = Render deployment.
// PASTE YOUR RENDER URL below once the service is live, then set ACTIVE to 'cloud'.
const SERVERS = {
    cloud: 'http://localhost:5000', // TODO: replace with https://preventvital-ocr.onrender.com
    local: 'http://192.168.0.103:5000',
};
const ACTIVE = 'local'; // flip to 'cloud' after first successful deploy
const SERVER = SERVERS[ACTIVE];
const APP_VERSION = `v6-${ACTIVE}`;

export default function App() {
    const [systolic, setSystolic] = useState('');
    const [diastolic, setDiastolic] = useState('');
    const [heartRate, setHeartRate] = useState('');
    const [glucose, setGlucose] = useState('');
    const [weight, setWeight] = useState('');
    const [spo2, setSpo2] = useState('');
    const [isScanning, setIsScanning] = useState(false);

    const processOCR = async (uri, mimeType, fileName) => {
        setIsScanning(true);
        try {
            // Fetch the picked file as a Blob. In React Native, fetch supports
            // both file:// and content:// URIs and returns a real Blob — no
            // FileSystem API needed (the new API's File.bytes() lacks READ
            // permission for picker-produced paths, and the legacy
            // readAsStringAsync fails the same way). The Blob is then uploaded
            // directly, which RN FormData fully supports.
            let blob;
            try {
                const fetched = await fetch(uri);
                blob = await fetched.blob();
            } catch (fileErr) {
                throw new Error(`Could not read the picked file (${fileErr.message}). Try saving it to your Gallery or Files first.`);
            }

            const formData = new FormData();
            formData.append('reports', blob, fileName || 'report');

            const response = await fetch(`${SERVER}/api/extract`, {
                method: 'POST',
                body: formData,
                headers: {
                    'Accept': 'application/json',
                },
            });

            const data = await response.json();
            if (data.ok && data.formValues) {
                const fv = data.formValues;
                if (fv.sbp) setSystolic(String(fv.sbp));
                if (fv.dbp) setDiastolic(String(fv.dbp));
                if (fv.fbg || fv.hba1c) setGlucose(String(fv.fbg || fv.hba1c));
                if (fv.weight) setWeight(String(fv.weight));
                if (fv.hr) setHeartRate(String(fv.hr));
                if (fv.spo2) setSpo2(String(fv.spo2));

                Alert.alert('Success', 'Report processed! Values auto-filled.');
            } else {
                Alert.alert('OCR Notice', data.messages?.[0]?.text || 'Could not extract data.');
            }
        } catch (err) {
            Alert.alert(
                'Connection Error',
                `Server unreachable: ${err.message}\n\n` +
                `If this persists:\n1. Confirm phone Wi-Fi = same as PC\n2. Turn off VPN / Private DNS\n3. Test http://192.168.0.101:5000 in phone browser`
            );
        } finally {
            setIsScanning(false);
        }
    };

    const pickImage = async () => {
        try {
            const result = await ImagePicker.launchImageLibraryAsync({
                // Removing mediaTypes entirely. By default, it handles images.
                allowsEditing: false,
                quality: 1,
            });
            if (!result.canceled) {
                const a = result.assets[0];
                processOCR(a.uri, a.mimeType || 'image/jpeg', a.fileName || 'report.jpg');
            }
        } catch (e) {
            Alert.alert('Error', 'Failed to pick image: ' + e.message);
        }
    };

    const takePhoto = async () => {
        try {
            const permission = await ImagePicker.requestCameraPermissionsAsync();
            if (!permission.granted) {
                Alert.alert('Permission Required', 'Allow camera access to scan.');
                return;
            }
            const result = await ImagePicker.launchCameraAsync({
                allowsEditing: false,
                quality: 1,
            });
            if (!result.canceled) {
                const a = result.assets[0];
                processOCR(a.uri, a.mimeType || 'image/jpeg', a.fileName || 'camera.jpg');
            }
        } catch (e) {
            Alert.alert('Error', 'Failed to take photo: ' + e.message);
        }
    };

    const pickDocument = async () => {
        try {
            const result = await DocumentPicker.getDocumentAsync({
                type: ['application/pdf', 'image/*'],
            });
            if (!result.canceled) {
                const a = result.assets[0];
                processOCR(a.uri, a.mimeType || 'application/pdf', a.name || a.uri.split('/').pop() || 'report.pdf');
            }
        } catch (e) {
            Alert.alert('Error', 'Failed to pick document: ' + e.message);
        }
    };

    return (
        <SafeAreaView style={styles.container}>
            <StatusBar style="auto" />
            <View style={styles.header}>
                <Text style={styles.headerTitle}>PreventVital OCR Core {APP_VERSION}</Text>
                <Text style={styles.headerSub}>Professional Vitals Extraction</Text>
            </View>

            <ScrollView contentContainerStyle={styles.content}>
                <View style={styles.actionCard}>
                    <Text style={styles.actionTitle}>Scan Medical Report</Text>
                    <Text style={styles.actionSub}>Choose a method to upload your lab report</Text>

                    <View style={styles.btnRow}>
                        <TouchableOpacity style={styles.btn} onPress={takePhoto}>
                            <Ionicons name="camera" size={24} color="#6366F1" />
                            <Text style={styles.btnText}>Camera</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.btn} onPress={pickImage}>
                            <Ionicons name="image" size={24} color="#6366F1" />
                            <Text style={styles.btnText}>Gallery</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.btn} onPress={pickDocument}>
                            <Ionicons name="document-text" size={24} color="#6366F1" />
                            <Text style={styles.btnText}>PDF</Text>
                        </TouchableOpacity>
                    </View>
                    {isScanning && <ActivityIndicator color="#6366F1" style={{ marginTop: 20 }} />}
                </View>

                <View style={styles.resultsCard}>
                    <Text style={styles.resultsTitle}>Extracted Vitals</Text>

                    <View style={styles.inputRow}>
                        <Text style={styles.label}>Systolic</Text>
                        <TextInput style={styles.input} value={systolic} editable={false} />
                    </View>
                    <View style={styles.inputRow}>
                        <Text style={styles.label}>Diastolic</Text>
                        <TextInput style={styles.input} value={diastolic} editable={false} />
                    </View>
                    <View style={styles.inputRow}>
                        <Text style={styles.label}>Heart Rate</Text>
                        <TextInput style={styles.input} value={heartRate} editable={false} />
                    </View>
                    <View style={styles.inputRow}>
                        <Text style={styles.label}>Glucose</Text>
                        <TextInput style={styles.input} value={glucose} editable={false} />
                    </View>
                    <View style={styles.inputRow}>
                        <Text style={styles.label}>Weight</Text>
                        <TextInput style={styles.input} value={weight} editable={false} />
                    </View>
                    <View style={styles.inputRow}>
                        <Text style={styles.label}>SpO2</Text>
                        <TextInput style={styles.input} value={spo2} editable={false} />
                    </View>
                </View>
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#F8FAFC' },
    header: { padding: 30, backgroundColor: '#fff', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#E2E8F0' },
    headerTitle: { fontSize: 24, fontWeight: 'bold', color: '#1E293B' },
    headerSub: { fontSize: 14, color: '#64748B', marginTop: 4 },
    content: { padding: 20 },
    actionCard: {
        backgroundColor: '#fff',
        padding: 20,
        borderRadius: 24,
        alignItems: 'center',
        marginBottom: 24,
        elevation: 4,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.1,
        shadowRadius: 12,
    },
    actionTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B', marginBottom: 5 },
    actionSub: { fontSize: 14, color: '#64748B', marginBottom: 20 },
    btnRow: { flexDirection: 'row', gap: 12, justifyContent: 'center' },
    btn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: '#EEF2FF',
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: '#C7D2FE',
    },
    btnText: { fontSize: 14, fontWeight: '600', color: '#4338CA' },
    resultsCard: {
        backgroundColor: '#fff',
        padding: 24,
        borderRadius: 24,
        elevation: 4,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.1,
        shadowRadius: 12,
    },
    resultsTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B', marginBottom: 20 },
    inputRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
    label: { fontSize: 15, color: '#475569', fontWeight: '500' },
    input: {
        borderWidth: 1,
        borderColor: '#E2E8F0',
        borderRadius: 10,
        padding: 10,
        width: 120,
        textAlign: 'right',
        color: '#1E293B',
        backgroundColor: '#F9FAFB'
    }
});
