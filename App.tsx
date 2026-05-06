import AsyncStorage from '@react-native-async-storage/async-storage';
import { fromByteArray } from 'base64-js';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

type WorkoutSet = {
  id: string;
  exercise: string;
  weight: number;
  reps: number;
  createdAt: string;
};
type WorkoutSession = {
  startedAt: string;
  endedAt?: string;
};

const STORAGE_KEY = 'gym-assistant-v1-sets';
const SESSION_STORAGE_KEY = 'gym-assistant-v1-session';
const GEMINI_API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY;
const ELEVENLABS_API_KEY = process.env.EXPO_PUBLIC_ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.EXPO_PUBLIC_ELEVENLABS_VOICE_ID;
const WEIGHT_UNIT = 'kg';
const GEMINI_MODEL = 'gemini-2.0-flash';

const EXERCISE_ALIASES: Record<string, string> = {
  bench: 'barbell bench press',
  benchpress: 'barbell bench press',
  'barbell bench press': 'barbell bench press',
};

function normalizeExercise(input: string): string {
  const normalized = input.trim().toLowerCase();
  return EXERCISE_ALIASES[normalized] ?? normalized;
}

function parseSetLogIntent(rawText: string): { exercise: string; weight: number; reps: number } | null {
  const text = rawText.toLowerCase().trim();
  const match = text.match(/(?:log|add)\s+(.+?)\s+(\d+(?:\.\d+)?)\s*(?:x|for)\s*(\d+)/i);
  if (!match) {
    return null;
  }

  return {
    exercise: normalizeExercise(match[1]),
    weight: Number(match[2]),
    reps: Number(match[3]),
  };
}

function askForLastBench(rawText: string): boolean {
  const text = rawText.toLowerCase();
  return text.includes('last bench') || text.includes('how much did i bench');
}

function asksForBackExercises(rawText: string): boolean {
  const text = rawText.toLowerCase();
  return text.includes('for back') || text.includes('target back');
}

export default function App() {
  const [sets, setSets] = useState<WorkoutSet[]>([]);
  const [activeSession, setActiveSession] = useState<WorkoutSession | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [isProcessingVoice, setIsProcessingVoice] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [assistantReply, setAssistantReply] = useState(
    `Hold to talk and release. Example: "log bench 100 x 5" (${WEIGHT_UNIT}).`
  );
  const recordingRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);

  useEffect(() => {
    const loadSets = async () => {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as WorkoutSet[];
      setSets(parsed);

      const rawSession = await AsyncStorage.getItem(SESSION_STORAGE_KEY);
      if (rawSession) {
        setActiveSession(JSON.parse(rawSession) as WorkoutSession);
      }
    };

    loadSets().catch(() => {
      Alert.alert('Load error', 'Could not load your saved workout history.');
    });
  }, []);

  useEffect(() => {
    return () => {
      if (soundRef.current) {
        soundRef.current.unloadAsync().catch(() => {
          // no-op cleanup
        });
      }
    };
  }, []);

  const latestBenchSet = useMemo(() => {
    return sets
      .filter((setItem) => setItem.exercise === 'barbell bench press')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }, [sets]);

  const persistSets = async (nextSets: WorkoutSet[]) => {
    setSets(nextSets);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(nextSets));
  };

  const handleTypedCommand = async () => {
    Keyboard.dismiss();
    await processCommand(transcript);
  };

  const startSession = async () => {
    const session: WorkoutSession = { startedAt: new Date().toISOString() };
    setActiveSession(session);
    await AsyncStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  };

  const endSession = async () => {
    setActiveSession(null);
    await AsyncStorage.removeItem(SESSION_STORAGE_KEY);
  };

  const speakReply = async (text: string) => {
    if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
      return;
    }

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
        }),
      }
    );

    if (!response.ok) {
      return;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const audioPath = `${FileSystem.cacheDirectory}assistant-reply-${Date.now()}.mp3`;
    await FileSystem.writeAsStringAsync(audioPath, fromByteArray(bytes), {
      encoding: FileSystem.EncodingType.Base64,
    });

    if (soundRef.current) {
      await soundRef.current.unloadAsync();
      soundRef.current = null;
    }

    const { sound } = await Audio.Sound.createAsync(
      { uri: audioPath },
      { shouldPlay: true }
    );
    soundRef.current = sound;
  };

  const processCommand = async (sourceText: string) => {
    if (!sourceText.trim()) {
      setAssistantReply('I did not catch that. Try: "log bench 185 x 8".');
      return;
    }

    const parsedSet = parseSetLogIntent(sourceText);
    const normalizedText = sourceText.trim().toLowerCase();

    if (normalizedText.includes('start workout')) {
      if (activeSession) {
        const reply = 'Workout already active. You can keep logging sets.';
        setAssistantReply(reply);
        await speakReply(reply);
        return;
      }
      await startSession();
      const reply = 'Workout started. Tell me sets like "log bench 100 x 5".';
      setAssistantReply(reply);
      await speakReply(reply);
      return;
    }

    if (normalizedText.includes('end workout')) {
      if (!activeSession) {
        const reply = 'No active workout to end.';
        setAssistantReply(reply);
        await speakReply(reply);
        return;
      }
      await endSession();
      const reply = 'Workout ended. Nice session.';
      setAssistantReply(reply);
      await speakReply(reply);
      return;
    }

    if (parsedSet) {
      const nextEntry: WorkoutSet = {
        id: `${Date.now()}`,
        exercise: parsedSet.exercise,
        weight: parsedSet.weight,
        reps: parsedSet.reps,
        createdAt: new Date().toISOString(),
      };
      const nextSets = [nextEntry, ...sets];
      await persistSets(nextSets);
      const reply = `Saved: ${parsedSet.exercise} ${parsedSet.weight} ${WEIGHT_UNIT} x ${parsedSet.reps}. Ask me "How much did I bench last session?"`;
      setAssistantReply(reply);
      await speakReply(reply);
      setTranscript('');
      return;
    }

    if (askForLastBench(sourceText)) {
      if (!latestBenchSet) {
        const reply = 'No bench history yet. Try: "log bench 60 x 10".';
        setAssistantReply(reply);
        await speakReply(reply);
        return;
      }
      const date = new Date(latestBenchSet.createdAt).toLocaleString();
      const reply = `Last bench: ${latestBenchSet.weight} ${WEIGHT_UNIT} x ${latestBenchSet.reps} on ${date}.`;
      setAssistantReply(reply);
      await speakReply(reply);
      setTranscript('');
      return;
    }

    if (asksForBackExercises(sourceText)) {
      const reply =
        'For back: lat pulldown, pull-ups, barbell row, seated cable row, and chest-supported row. Start with 3-4 exercises, 2-4 sets each.';
      setAssistantReply(reply);
      await speakReply(reply);
      return;
    }

    const reply =
      'I can log sets and answer last bench right now. Example commands: "log bench 225 x 5", "how much did I bench last session?"'
    setAssistantReply(reply);
    await speakReply(reply);
  };

  const startRecording = async () => {
    if (isProcessingVoice) {
      return;
    }
    const permission = await Audio.requestPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission required', 'Please allow microphone access to use push-to-talk.');
      return;
    }

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });

    const { recording } = await Audio.Recording.createAsync(
      Audio.RecordingOptionsPresets.HIGH_QUALITY
    );
    recordingRef.current = recording;
    setIsListening(true);
  };

  const transcribeWithGemini = async (uri: string): Promise<string> => {
    if (!GEMINI_API_KEY) {
      throw new Error('Missing EXPO_PUBLIC_GEMINI_API_KEY');
    }

    const audioBase64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: 'Transcribe this gym voice note exactly. Return only plain transcript text.',
              },
              {
                inlineData: {
                  mimeType: 'audio/mp4',
                  data: audioBase64,
                },
              },
            ],
          },
        ],
      }),
    }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini transcription failed: ${errorText}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
  };

  const stopRecordingAndProcess = async () => {
    const recording = recordingRef.current;
    recordingRef.current = null;
    setIsListening(false);

    if (!recording) {
      return;
    }

    setIsProcessingVoice(true);
    try {
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      if (!uri) {
        throw new Error('No audio recording URI found.');
      }
      const spokenText = await transcribeWithGemini(uri);
      setTranscript(spokenText);
      await processCommand(spokenText);
    } catch (error) {
      const details =
        error instanceof Error ? error.message : 'Unknown voice processing error.';
      Alert.alert('Voice error', details);
    } finally {
      setIsProcessingVoice(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <Text style={styles.title}>Gym Voice Assistant (V1)</Text>
        <Text style={styles.subtitle}>Push-to-talk uses Gemini transcription. Weights default to kg.</Text>
        <Text style={styles.sessionText}>
          Session: {activeSession ? 'Active' : 'Inactive'}
        </Text>

        <View style={styles.replyCard}>
          <Text style={styles.replyLabel}>Assistant</Text>
          <Text style={styles.replyText}>{assistantReply}</Text>
        </View>

        <TextInput
          placeholder="You can still type commands here..."
          placeholderTextColor="#888"
          style={styles.input}
          value={transcript}
          onChangeText={setTranscript}
          returnKeyType="done"
          onSubmitEditing={() => {
            handleTypedCommand().catch(() => {
              Alert.alert('Command error', 'Could not process typed command.');
            });
          }}
          multiline
        />

        <TouchableOpacity
          style={[styles.button, isListening ? styles.buttonActive : null]}
          onPressIn={() => {
            startRecording().catch(() => {
              Alert.alert('Mic error', 'Could not start microphone recording.');
            });
          }}
          onPressOut={() => {
            stopRecordingAndProcess().catch(() => {
              Alert.alert('Command error', 'Could not process your command.');
            });
          }}
        >
          <Text style={styles.buttonText}>{isListening ? 'Listening...' : 'Hold to Talk'}</Text>
        </TouchableOpacity>
        {isProcessingVoice ? <ActivityIndicator style={styles.loader} color="#93c5fd" /> : null}

        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => {
            handleTypedCommand().catch(() => {
              Alert.alert('Command error', 'Could not process typed command.');
            });
          }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.secondaryButtonText}>Process Typed Command</Text>
        </TouchableOpacity>

        <Text style={styles.historyTitle}>Recent Sets</Text>
        <FlatList
          data={sets.slice(0, 6)}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <Text style={styles.setRow}>
              {item.exercise} - {item.weight} {WEIGHT_UNIT} x {item.reps}
            </Text>
          )}
          ListEmptyComponent={<Text style={styles.emptyText}>No sets logged yet.</Text>}
        />
        </ScrollView>
      </KeyboardAvoidingView>
      <StatusBar style="auto" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  container: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  content: {
    paddingBottom: 24,
  },
  title: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 24,
  },
  subtitle: {
    color: '#cbd5e1',
    marginTop: 8,
    marginBottom: 18,
  },
  sessionText: {
    color: '#94a3b8',
    marginBottom: 14,
  },
  replyCard: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  replyLabel: {
    color: '#94a3b8',
    marginBottom: 6,
    fontSize: 12,
    textTransform: 'uppercase',
  },
  replyText: {
    color: '#e2e8f0',
    fontSize: 15,
    lineHeight: 21,
  },
  input: {
    borderColor: '#334155',
    borderWidth: 1,
    borderRadius: 12,
    backgroundColor: '#0b1220',
    color: '#fff',
    padding: 12,
    minHeight: 84,
    textAlignVertical: 'top',
  },
  button: {
    marginTop: 12,
    backgroundColor: '#2563eb',
    borderRadius: 12,
    alignItems: 'center',
    paddingVertical: 14,
  },
  buttonActive: {
    backgroundColor: '#dc2626',
  },
  buttonText: {
    color: '#fff',
    fontWeight: '700',
  },
  loader: {
    marginTop: 10,
  },
  secondaryButton: {
    marginTop: 10,
    borderColor: '#475569',
    borderWidth: 1,
    borderRadius: 12,
    alignItems: 'center',
    paddingVertical: 12,
  },
  secondaryButtonText: {
    color: '#cbd5e1',
    fontWeight: '600',
  },
  historyTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 20,
    marginBottom: 8,
  },
  setRow: {
    color: '#cbd5e1',
    paddingVertical: 4,
  },
  emptyText: {
    color: '#64748b',
    paddingVertical: 4,
  },
});
