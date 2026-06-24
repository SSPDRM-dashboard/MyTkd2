import React, { useState, useRef } from 'react';
import { 
  Upload, 
  FileText, 
  Table, 
  GitBranch, 
  CheckCircle2, 
  AlertCircle, 
  RefreshCw, 
  Save,
  ChevronRight,
  Trophy,
  FileSpreadsheet,
  File as FileIcon,
  X,
  Send,
  Sparkles,
  Zap
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import { MatchData, BoutMapping, EventData, RingStatus } from '../types';
import { cn, normalizeBoutNumber, formatBoutNumber, isBoutMatch, normalizeBoutWithRing, getBoutNumber } from '../lib/utils';
import { collection, addDoc, serverTimestamp, setDoc, doc } from 'firebase/firestore';
import { handleGlobalQuotaTrigger, isFirestoreQuotaExceeded } from '../App';
import { db } from '../firebase';
import { syncToGoogleSheets } from '../services/googleSheets';
import Papa from 'papaparse';

function cleanAndParseJSON(rawText: string | undefined): any {
  if (!rawText) {
    throw new Error("No response content was received from the AI.");
  }

  let cleaned = rawText.trim();

  // 1. Strip markdown code block wraps
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n/i, "");
    cleaned = cleaned.replace(/\n```$/, "");
    cleaned = cleaned.trim();
  }

  // 2. Try simple JSON.parse first
  try {
    return JSON.parse(cleaned);
  } catch (initialError: any) {
    console.warn("Initial JSON parse failed. Running deep repair...", initialError.message);
  }

  // State-machine based parsing and repair to handle:
  // - Unescaped double quotes inside values
  // - Truncated JSON (closes open braces/brackets/quotes)
  // - Trailing commas
  let repaired = "";
  let inString = false;
  let escapeNext = false;
  let bracketStack: string[] = [];
  const chars = Array.from(cleaned);
  
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    
    if (escapeNext) {
      repaired += char;
      escapeNext = false;
      continue;
    }
    
    if (char === '\\') {
      repaired += char;
      escapeNext = true;
      continue;
    }
    
    if (char === '"') {
      if (inString) {
        // We are currently inside a string. Determine if this double quote
        // is genuinely the end of the string or if it's an unescaped raw quote inside the string.
        let peekIdx = i + 1;
        while (peekIdx < chars.length && /\s/.test(chars[peekIdx])) {
          peekIdx++;
        }
        
        const nextChar = chars[peekIdx];
        const isGenuineEnd = 
          peekIdx >= chars.length || // End of text
          nextChar === ',' || 
          nextChar === ':' || 
          nextChar === '}' || 
          nextChar === ']';
          
        if (isGenuineEnd) {
          inString = false;
          repaired += '"';
        } else {
          // Nested unescaped quote! Escape it.
          repaired += '\\"';
        }
      } else {
        inString = true;
        repaired += '"';
      }
      continue;
    }
    
    if (inString) {
      // Inside a string, just append the character
      repaired += char;
    } else {
      // Outside a string, track braces and brackets
      if (char === '{' || char === '[') {
        bracketStack.push(char);
      } else if (char === '}') {
        if (bracketStack[bracketStack.length - 1] === '{') {
          bracketStack.pop();
        }
      } else if (char === ']') {
        if (bracketStack[bracketStack.length - 1] === '[') {
          bracketStack.pop();
        }
      }
      repaired += char;
    }
  }

  // Handle truncation (unterminated strings or open brackets)
  if (inString) {
    repaired += '"';
  }

  // Remove trailing commas before closing braces/brackets
  repaired = repaired.replace(/,\s*([}\]])/g, "$1");

  // Close any unclosed brackets
  while (bracketStack.length > 0) {
    const last = bracketStack.pop();
    if (last === '{') {
      repaired += '}';
    } else if (last === '[') {
      repaired += ']';
    }
  }

  try {
    return JSON.parse(repaired);
  } catch (finalError: any) {
    console.error("Deep repair failed. Raw text:", rawText);
    console.log("Repaired attempt:", repaired);
    throw new Error(`JSON parsing failed: ${finalError.message}. Help: Ensure nicknames or special names are escaped.`);
  }
}

interface AIBracketSetupProps {
  currentEventId: string | null;
  events: EventData[];
  onSelectEvent?: (id: string) => void;
  onSuccess?: () => void;
  rings: RingStatus[];
  setRings: (rings: RingStatus[]) => void;
  setBoutQueue: React.Dispatch<React.SetStateAction<{id: string, data: MatchData}[]>>;
  boutNumberingMode: 'numeric' | 'alphanumeric';
  setBackupData: React.Dispatch<React.SetStateAction<Record<string, { mappings: BoutMapping[], matches: MatchData[] }>>>;
  backupToLoad?: { mappings: Partial<BoutMapping>[], matches: MatchData[] } | null;
  clearBackupToLoad?: () => void;
}

export function AIBracketSetup({ 
  currentEventId, 
  events, 
  onSelectEvent,
  onSuccess, 
  rings, 
  setRings, 
  setBoutQueue,
  boutNumberingMode,
  setBackupData,
  backupToLoad,
  clearBackupToLoad
}: AIBracketSetupProps) {
  const [file, setFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<{
    matches: MatchData[];
    mappings: Partial<BoutMapping>[];
    fileName?: string;
    fileType?: string;
  } | null>(() => {
    if (backupToLoad && (backupToLoad.mappings.length > 0 || backupToLoad.matches.length > 0)) {
      return {
        matches: backupToLoad.matches || [],
        mappings: backupToLoad.mappings || [],
        fileName: 'Recovered Bracket Logic',
        fileType: 'backup'
      };
    }
    const key = currentEventId ? `tkd_ai_preview_data_${currentEventId}` : 'tkd_ai_preview_data';
    const saved = localStorage.getItem(key);
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        return null;
      }
    }
    return null;
  });
  const [activePreviewTab, setActivePreviewTab] = useState<'matches' | 'mappings'>('matches');
  const [adminNote, setAdminNote] = useState(() => {
    const key = currentEventId ? `tkd_ai_admin_note_${currentEventId}` : 'tkd_ai_admin_note';
    return localStorage.getItem(key) || '';
  });
  const [isDragging, setIsDragging] = useState(false);
  const [isThinkingMode, setIsThinkingMode] = useState(false);
  const [isPoomsaeMode, setIsPoomsaeMode] = useState(() => {
    const key = currentEventId ? `tkd_ai_poomsae_mode_${currentEventId}` : 'tkd_ai_poomsae_mode';
    return localStorage.getItem(key) === 'true';
  });
  const [processedFiles, setProcessedFiles] = useState<Set<string>>(() => {
    const saved = localStorage.getItem('tkd_ai_processed_files');
    if (saved) {
      try {
        return new Set(JSON.parse(saved));
      } catch (e) {
        return new Set();
      }
    }
    return new Set();
  });

  // Handle backup file loading
  React.useEffect(() => {
    if (backupToLoad) {
      setActivePreviewTab('mappings');
      if (clearBackupToLoad) {
        // Clear it on a slight delay so it doesn't trigger Immediate parent re-renders that clash
        setTimeout(() => clearBackupToLoad(), 100);
      }
    }
  }, [backupToLoad, clearBackupToLoad]);

  // Persist state changes
  React.useEffect(() => {
    if (currentEventId) {
      const key = `tkd_ai_preview_data_${currentEventId}`;
      if (previewData) {
        localStorage.setItem(key, JSON.stringify(previewData));
      } else {
        localStorage.removeItem(key);
      }
    }
  }, [previewData, currentEventId]);

  React.useEffect(() => {
    if (currentEventId) {
      localStorage.setItem(`tkd_ai_admin_note_${currentEventId}`, adminNote);
      localStorage.setItem(`tkd_ai_poomsae_mode_${currentEventId}`, String(isPoomsaeMode));
    }
  }, [adminNote, isPoomsaeMode, currentEventId]);

  // Load data when event changes
  React.useEffect(() => {
    if (currentEventId && !backupToLoad) {
      const savedData = localStorage.getItem(`tkd_ai_preview_data_${currentEventId}`);
      if (savedData) {
        try {
          setPreviewData(JSON.parse(savedData));
        } catch (e) {
          setPreviewData(null);
        }
      } else {
        setPreviewData(null);
      }

      const savedNote = localStorage.getItem(`tkd_ai_admin_note_${currentEventId}`);
      setAdminNote(savedNote || '');

      const savedPoomsae = localStorage.getItem(`tkd_ai_poomsae_mode_${currentEventId}`);
      setIsPoomsaeMode(savedPoomsae === 'true');
    } else if (currentEventId && backupToLoad) {
      // Just load the note and poomsae mode
      const savedNote = localStorage.getItem(`tkd_ai_admin_note_${currentEventId}`);
      setAdminNote(savedNote || '');

      const savedPoomsae = localStorage.getItem(`tkd_ai_poomsae_mode_${currentEventId}`);
      setIsPoomsaeMode(savedPoomsae === 'true');
    }
  }, [currentEventId]);

  React.useEffect(() => {
    localStorage.setItem('tkd_ai_processed_files', JSON.stringify(Array.from(processedFiles)));
  }, [processedFiles]);

  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [showDuplicateModal, setShowDuplicateModal] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentEvent = events.find(e => e.id === currentEventId);

  const clearResults = () => {
    setPreviewData(null);
    setFile(null);
    setError(null);
  };

  const refineWithAI = async () => {
    if (!previewData) return;
    setIsProcessing(true);
    setError(null);

    try {
      const apiKey = import.meta.env.VITE_CUSTOM_API_KEY || import.meta.env.VITE_GEMINI_API_KEY || process.env.CUSTOM_API_KEY || process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("No API Key found. When deploying to Vercel, make sure to add VITE_GEMINI_API_KEY or VITE_CUSTOM_API_KEY to your environment variables.");
      console.log("Using API Key starting with:", apiKey.substring(0, 5), "Is Custom?", !!import.meta.env.VITE_CUSTOM_API_KEY);

      const ai = new GoogleGenAI({ apiKey });
      const prompt = `
        You are an expert tournament bracket auditor. I have extracted match data and advancement mappings from a bracket.
        Please review the following JSON and fix any logical inconsistencies.
        
        COMMON ISSUES TO FIX:
        1. Bout numbers that don't match the ring (e.g. Bout 101 should be Ring 1).
        2. Mappings where the sourceBout doesn't exist in the matches list.
        3. Mappings where sourceBout and nextBout are the same.
        4. Inconsistent capitalization (everything should be UPPERCASE).
        5. Missing categories or club names if they can be inferred from context.
        
        ${isPoomsaeMode ? `
        POOMSAE MODE ACTIVE:
        - This event is Poomsae/Freestyle.
        - Ensure solo performers are correctly placed (Blue slot active, Red slot empty).
        - Explicitly include "POOMSAE" in categories.
        ` : ''}

        ${adminNote ? `ADMIN NOTE: ${adminNote}` : ''}
        
        CURRENT DATA:
        ${JSON.stringify(previewData, null, 2)}
        
        Return ONLY the corrected JSON in the same format.

        CRITICAL FORMATTING RULES:
        - Do not include unescaped double quotes inside string values under any circumstances (e.g., nicknames, abbreviations, or club names). If a name has quotes like "John "The Dragon" Smith", return "John \"The Dragon\" Smith" or "John 'The Dragon' Smith".
        - The output must be standard compliant JSON, with all property names and string values strictly enclosed in double quotes.
      `;

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              matches: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { ring: { type: Type.NUMBER }, bout: { type: Type.STRING }, category: { type: Type.STRING }, blue_name: { type: Type.STRING }, blue_club: { type: Type.STRING }, red_name: { type: Type.STRING }, red_club: { type: Type.STRING } } } },
              mappings: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { sourceBout: { type: Type.STRING }, nextBout: { type: Type.STRING }, slot: { type: Type.STRING } } } }
            }
          }
        }
      });

      const result = cleanAndParseJSON(response.text);
      setPreviewData(result);
    } catch (err: any) {
      console.error("Refinement Error:", err);
      setError("Failed to refine data. Please try again.");
    } finally {
      setIsProcessing(false);
    }
  };

  const acceptFile = (selectedFile: File) => {
    setFile(selectedFile);
    setError(null);
    setPreviewData(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const checkAndAcceptFile = (selectedFile: File) => {
    const fileSig = `${selectedFile.name}-${selectedFile.size}`;
    if (processedFiles.has(fileSig)) {
      setPendingFile(selectedFile);
      setShowDuplicateModal(true);
    } else {
      acceptFile(selectedFile);
    }
  };

  const handleMatchEdit = (index: number, field: keyof MatchData, value: string) => {
    if (!previewData) return;
    const newMatches = [...previewData.matches];
    newMatches[index] = { ...newMatches[index], [field]: value };
    setPreviewData({ ...previewData, matches: newMatches });
  };

  const handleMappingEdit = (index: number, field: keyof BoutMapping, value: string) => {
    if (!previewData) return;
    const newMappings = [...previewData.mappings];
    newMappings[index] = { ...newMappings[index], [field]: value };
    setPreviewData({ ...previewData, mappings: newMappings });
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile) {
      checkAndAcceptFile(droppedFile);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      checkAndAcceptFile(selectedFile);
    }
    // Clear the input value so the same file can be selected again
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const base64String = (reader.result as string).split(',')[1];
        resolve(base64String);
      };
      reader.onerror = error => reject(error);
    });
  };

  const processFile = async () => {
    if (!file || !currentEventId) {
      setError("Please select a file and ensure an event is selected.");
      return;
    }

    setIsProcessing(true);
    setError(null);
    setPreviewData(null);

    // Handle CSV files locally (No API Key required)
    if (file.name.toLowerCase().endsWith('.csv')) {
      try {
        const text = await file.text();
        Papa.parse(text, {
          header: false,
          skipEmptyLines: true,
          complete: (results) => {
            const rows = results.data as string[][];
            if (rows.length < 2) {
              setError("CSV is empty or too short.");
              setIsProcessing(false);
              return;
            }

            const rawHeaders = rows[0];
            const cleanHeaders = rawHeaders.map(h => (h || '').toLowerCase().trim().replace(/[^a-z0-9]/g, ''));

            // Index detection
            let boutIdx = cleanHeaders.findIndex(h => h.includes('bout') || h.includes('match') || h.includes('no'));
            if (boutIdx === -1) {
              boutIdx = cleanHeaders.findIndex(h => h.includes('bt') || h.includes('#'));
              if (boutIdx === -1) boutIdx = 0;
            }

            let ringIdx = cleanHeaders.findIndex(h => h.includes('ring') || h.includes('court'));
            
            let catIdx = cleanHeaders.findIndex(h => h.includes('category') || h.includes('class') || h.includes('division') || h.includes('event'));
            if (catIdx === -1) catIdx = 1;

            let blueNameIdx = cleanHeaders.findIndex(h => h.includes('blue') || h.includes('chung') || h.includes('performer'));
            if (blueNameIdx === -1) {
              blueNameIdx = cleanHeaders.findIndex(h => h.includes('player') || h.includes('name') || h === 'competitor');
              if (blueNameIdx === -1) blueNameIdx = 2; // fallback
            }

            let redNameIdx = cleanHeaders.findIndex((h, idx) => (h.includes('red') || h.includes('hong')) && idx !== blueNameIdx);
            if (redNameIdx === -1) {
              redNameIdx = cleanHeaders.findIndex((h, idx) => (h.includes('player') || h.includes('name') || h === 'competitor') && idx !== blueNameIdx);
              if (redNameIdx === -1) redNameIdx = 4; // fallback
            }

            // Clubs are usually the column immediately following the name
            let blueClubIdx = cleanHeaders.findIndex((h, idx) => h.includes('club') && idx < (redNameIdx !== -1 ? redNameIdx : 99));
            if (blueClubIdx === -1 || blueClubIdx === blueNameIdx) {
              blueClubIdx = blueNameIdx + 1;
            }

            let redClubIdx = cleanHeaders.findIndex((h, idx) => h.includes('club') && idx > blueClubIdx);
            if (redClubIdx === -1 || redClubIdx === redNameIdx) {
              redClubIdx = redNameIdx + 1;
            }

            const dataRows = rows.slice(1);
            const matches: MatchData[] = dataRows.map((row: string[]) => {
              const b = (row[boutIdx] || '').toString().toUpperCase();
              const r = ringIdx !== -1 && row[ringIdx] ? parseInt(row[ringIdx]) : 1;
              const cat = (row[catIdx] || '').toString().toUpperCase();
              const blue = (row[blueNameIdx] || '').toString().toUpperCase();
              const bClub = (row[blueClubIdx] || '').toString().toUpperCase();
              const red = (row[redNameIdx] || '').toString().toUpperCase();
              const rClub = (row[redClubIdx] || '').toString().toUpperCase();

              return {
                bout: b,
                ring: isNaN(r) ? 1 : r,
                category: cat,
                blue_name: blue,
                blue_club: bClub,
                red_name: isPoomsaeMode ? '' : red,
                red_club: isPoomsaeMode ? '' : rClub,
                privacy_mode: false,
                eventId: currentEventId,
                is_poomsae_solo: isPoomsaeMode
              } as MatchData;
            }).filter(m => m.bout && m.category);

            if (matches.length === 0) {
              setError("No valid match data found in CSV. Ensure headers match: Bout, Category, Blue Player, Red Player.");
              setIsProcessing(false);
              return;
            }

            setPreviewData({ matches, mappings: [] });
            setIsProcessing(false);
            setProcessedFiles(prev => {
              const newSet = new Set(prev);
              newSet.add(`${file.name}-${file.size}`);
              return newSet;
            });
          },
          error: (err) => {
            setError(`Failed to parse CSV: ${err.message}`);
            setIsProcessing(false);
          }
        });
        return;
      } catch (err: any) {
        setError(`Error reading file: ${err.message}`);
        setIsProcessing(false);
        return;
      }
    }

    // Check file size (max 15MB to stay safe with base64 encoding)
    const MAX_FILE_SIZE = 15 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
      setError(`File is too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Please use a file smaller than 15MB.`);
      setIsProcessing(false);
      return;
    }

    try {
      const apiKey = import.meta.env.VITE_CUSTOM_API_KEY || import.meta.env.VITE_GEMINI_API_KEY || process.env.CUSTOM_API_KEY || process.env.GEMINI_API_KEY;
      
      if (!apiKey) {
        throw new Error("No API Key found. When deploying to Vercel, make sure to add VITE_GEMINI_API_KEY or VITE_CUSTOM_API_KEY to your environment variables.");
      }
      console.log("Using API Key starting with:", apiKey.substring(0, 5), "Is Custom?", !!import.meta.env.VITE_CUSTOM_API_KEY);
      
      const ai = new GoogleGenAI({ apiKey });
      const base64Data = await fileToBase64(file);
      
      const prompt = `
        You are an expert tournament bracket analyzer. Extract the bracket structure from this image.
        
        CRITICAL RULES:
        - Vertical Hierarchy: Flow is LEFT to RIGHT.
        - Match IDs: Rectangular boxes with alphanumeric codes (e.g., A01, A05, 2001) are Bout IDs.
        - Color Assignment: Upper line = Blue Side (Chung), Lower line = Red Side (Hong).
        - Advancement: Winner of a previous match fills the slot (Upper=Blue, Lower=Red) in the next Bout ID box.
        - Player Names: Often start with "090 - ". Extract only the name.
        - Club Names: Located directly BELOW the player's name.
        - Ring Mapping: 
          - 1000s=Ring 1, 2000s=Ring 2, 3000s=Ring 3, 4000s=Ring 4, 5000s=Ring 5, 6000s=Ring 6, 
          - 7000s=Ring 7, 8000s=Ring 8, 9000s=Ring 9, 10000s=Ring 10, 11000s=Ring 11, 12000s=Ring 12.
          - If alphanumeric (e.g. A01), A=1, B=2, C=3, D=4, E=5, F=6, G=7, H=8, I=9, J=10, K=11, L=12.

        ${isPoomsaeMode ? `
        INDIVIDUAL POOMSAE MODE ACTIVE:
        - This document contains Poomsae performances that should be treated as individual solo entries.
        - Map EACH player as their own separate SOLO entry (put player in "blue_name", leave "red_name" and "red_club" EMPTY).
        - Use sequential bout numbers (e.g., 1, 2, 3, 4, 5...) based on the performance order in the document.
        - Every single participant in the category must get an individual match record.
        - The category name MUST include the suffix "INDIVIDUAL POOMSAE" (e.g., "Junior Female INDIVIDUAL POOMSAE").
        - If the document is a bracket, treat every individual player slot in that bracket as a unique solo bout.
        ` : 'STRICT RULE: Do NOT treat as Individual Poomsae. Every match MUST have a Blue and Red corner if data is available.'}

        ${adminNote ? `ADMIN NOTE: ${adminNote}` : ''}

        Return JSON:
        {
          "matches": [{"bout": "A01", "ring": 1, "category": "...", "blue_name": "...", "blue_club": "...", "red_name": "...", "red_club": "..."}],
          "mappings": [{"sourceBout": "A01", "nextBout": "A05", "slot": "Chung"}]
        }

        CRITICAL FORMATTING RULES:
        - Do not include unescaped double quotes inside string values under any circumstances (e.g., nicknames, abbreviations, or club names). If a name has quotes like "John "The Dragon" Smith", return "John \"The Dragon\" Smith" or "John 'The Dragon' Smith".
        - The output must be standard compliant JSON, with all property names and string values strictly enclosed in double quotes.
      `;

      const response = await ai.models.generateContent({
        model: isThinkingMode ? "gemini-3.1-pro-preview" : "gemini-3.5-flash",
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: file.type || "image/png",
                  data: base64Data,
                },
              },
            ],
          },
        ],
        config: {
          temperature: 0.1,
          responseMimeType: "application/json",
          thinkingConfig: isThinkingMode ? { thinkingLevel: ThinkingLevel.HIGH } : undefined,
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              matches: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    ring: { type: Type.NUMBER },
                    bout: { type: Type.STRING },
                    category: { type: Type.STRING },
                    blue_name: { type: Type.STRING },
                    blue_club: { type: Type.STRING },
                    red_name: { type: Type.STRING },
                    red_club: { type: Type.STRING },
                  },
                  required: ["bout", "category", "blue_name", "red_name"],
                },
              },
              mappings: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    sourceBout: { type: Type.STRING },
                    nextBout: { type: Type.STRING },
                    slot: { type: Type.STRING, enum: ["Chung", "Hong"] },
                  },
                  required: ["sourceBout", "nextBout", "slot"],
                },
              },
            },
          },
        },
      });

      const result = cleanAndParseJSON(response.text);
      const normalizedResult = {
        matches: Array.isArray(result.matches) ? result.matches : [],
        mappings: Array.isArray(result.mappings) ? result.mappings : []
      };

      // Capitalize and infer ring from bout number
      normalizedResult.matches = normalizedResult.matches.map((m: any) => {
        const bout = (m.bout || '').toString().toUpperCase();
        const prefix = bout.charAt(0);
        const boutNum = parseInt(bout.replace(/[^0-9]/g, ''));
        let inferredRing = m.ring;
        
        // Numeric range logic (1000s = Ring 1, 2000s = Ring 2, etc.)
        if (!isNaN(boutNum) && boutNum >= 1000) {
          inferredRing = Math.floor(boutNum / 1000);
        } 
        // Letter prefix logic
        else if (prefix === 'A') inferredRing = 1;
        else if (prefix === 'B') inferredRing = 2;
        else if (prefix === 'C') inferredRing = 3;
        else if (prefix === 'D') inferredRing = 4;
        else if (prefix === 'E') inferredRing = 5;
        else if (prefix === 'F') inferredRing = 6;
        else if (prefix === 'G') inferredRing = 7;
        else if (prefix === 'H') inferredRing = 8;

        let finalCategory = (m.category || '').toString().toUpperCase();
        if (isPoomsaeMode && !finalCategory.includes('INDIVIDUAL POOMSAE')) {
          finalCategory = finalCategory ? `${finalCategory} (INDIVIDUAL POOMSAE)` : 'INDIVIDUAL POOMSAE';
        }

        return {
          ...m,
          ring: Number(inferredRing) || 1,
          blue_name: (m.blue_name || '').toString().toUpperCase(),
          blue_club: (m.blue_club || '').toString().toUpperCase(),
          red_name: isPoomsaeMode ? '' : (m.red_name || '').toString().toUpperCase(),
          red_club: isPoomsaeMode ? '' : (m.red_club || '').toString().toUpperCase(),
          category: finalCategory,
          bout: bout,
          privacy_mode: false,
          is_poomsae_solo: isPoomsaeMode
        };
      });

      normalizedResult.mappings = normalizedResult.mappings.map((m: any) => ({
        ...m,
        sourceBout: (m.sourceBout || '').toString().toUpperCase(),
        nextBout: (m.nextBout || '').toString().toUpperCase()
      }));
      
      // Sort mappings by source bout number
      normalizedResult.mappings.sort((a: any, b: any) => {
        const parseBout = (bout: string | number) => {
          let s = bout.toString().replace(/\s+/g, '').toUpperCase();
          s = s.replace(/^([A-H])O+(\d+)([A-Z]*)$/, '$10$2$3');
          if (/^[A-Z]/.test(s)) return s;
          const parsed = parseInt(s.replace(/[^0-9]/g, ''));
          return isNaN(parsed) ? s : parsed;
        };
        const valA = parseBout(a.sourceBout || '');
        const valB = parseBout(b.sourceBout || '');
        if (typeof valA === 'number' && typeof valB === 'number') {
          if (valA !== valB) return valA - valB;
        } else if (typeof valA === 'string' && typeof valB === 'string') {
          if (valA !== valB) return valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' });
        } else if (typeof valA === 'number') return -1;
        else return 1;
        return 0;
      });

      // Sort matches by bout number
      normalizedResult.matches.sort((a: any, b: any) => {
        const parseBout = (bout: string | number) => {
          let s = bout.toString().replace(/\s+/g, '').toUpperCase();
          s = s.replace(/^([A-H])O+(\d+)([A-Z]*)$/, '$10$2$3');
          if (/^[A-Z]/.test(s)) return s;
          const parsed = parseInt(s.replace(/[^0-9]/g, ''));
          return isNaN(parsed) ? s : parsed;
        };
        const valA = parseBout(a.bout || '');
        const valB = parseBout(b.bout || '');
        if (typeof valA === 'number' && typeof valB === 'number') {
          if (valA !== valB) return valA - valB;
        } else if (typeof valA === 'string' && typeof valB === 'string') {
          if (valA !== valB) return valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' });
        } else if (typeof valA === 'number') return -1;
        else return 1;
        return 0;
      });

      setPreviewData({
        ...normalizedResult,
        fileName: file.name,
        fileType: file.type
      });
      setProcessedFiles(prev => {
        const newSet = new Set(prev);
        newSet.add(`${file.name}-${file.size}`);
        return newSet;
      });
    } catch (err: any) {
      console.error("AI Processing Error:", err);
      
      let errorMessage = "Failed to process the file. Please try again with a smaller file or a clearer image.";
      
      if (err instanceof Error) {
        const msg = err.message.toLowerCase();
        if (msg.includes("timed out")) {
          errorMessage = "The request timed out. The image might be too complex or the connection is slow.";
        } else if (msg.includes("api_key_invalid") || msg.includes("api key")) {
          errorMessage = "Invalid API Key. Please check your configuration.";
        } else if (msg.includes("quota") || msg.includes("rate limit")) {
          errorMessage = "API quota exceeded. Please try again in a few minutes.";
        } else if (msg.includes("model not found") || msg.includes("404")) {
          errorMessage = "The AI model is currently unavailable. Please contact support.";
        } else if (msg.includes("safety")) {
          errorMessage = "The file was flagged by safety filters. Please ensure it contains only tournament data.";
        } else {
          errorMessage = `Error: ${err.message}`;
        }
      }
      
      setError(errorMessage);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleApply = async () => {
    if (!previewData || !currentEventId || !currentEvent) return;

    setIsProcessing(true);
    try {
      // Helper to get ring from bout prefix or number
      const getRingFromBout = (bout: string | number) => {
        const boutStr = (bout || '').toString();
        const boutNum = parseInt(boutStr.replace(/[^0-9]/g, ''));
        if (!isNaN(boutNum) && boutNum >= 1000) {
          return Math.floor(boutNum / 1000);
        }

        const prefix = boutStr.charAt(0).toUpperCase();
        if (prefix === 'A') return 1;
        if (prefix === 'B') return 2;
        if (prefix === 'C') return 3;
        if (prefix === 'D') return 4;
        if (prefix === 'E') return 5;
        if (prefix === 'F') return 6;
        if (prefix === 'G') return 7;
        if (prefix === 'H') return 8;
        return 1;
      };

      // 0. Pre-process matches to ensure perfect data normalization (Uppercase, EventId, Ring Number, Normalized Bouts)
      const processedMatches = previewData.matches.map((m: MatchData) => {
        const rNum = Number(m.ring || getRingFromBout(m.bout));
        return {
          ...m,
          ring: rNum,
          eventId: currentEventId,
          blue_name: m.blue_name?.toUpperCase().trim() || '',
          blue_club: m.blue_club?.toUpperCase().trim() || '',
          red_name: m.red_name?.toUpperCase().trim() || '',
          red_club: m.red_club?.toUpperCase().trim() || '',
          category: m.category?.toUpperCase().trim() || '',
          bout: normalizeBoutWithRing(m.bout, rNum, m.originalRing),
          privacy_mode: m.privacy_mode || false
        };
      });

      // 1. Save Mappings to Firestore (event_logic) with uppercase category matching
      const mappingPromises = previewData.mappings.map(m => {
        const matchingMatch = processedMatches.find((match: MatchData) => 
          isBoutMatch(match.bout, m.sourceBout) || isBoutMatch(match.bout, m.nextBout)
        );
        const resolvedCategory = (m.categoryName || (matchingMatch ? matchingMatch.category : "Auto-Extracted from File")).toUpperCase().trim();

        if (isFirestoreQuotaExceeded) return Promise.resolve();
        return addDoc(collection(db, 'event_logic'), {
          ...m,
          sourceBout: normalizeBoutNumber(m.sourceBout || ''),
          nextBout: normalizeBoutNumber(m.nextBout || ''),
          eventId: currentEventId,
          eventName: currentEvent.name,
          categoryName: resolvedCategory,
          createdAt: serverTimestamp()
        });
      });

      // Also persist bracket matches + mappings to the "tournaments" doc to fully support the "Auto-fill from bracket data" button
      if (!isFirestoreQuotaExceeded) {
        await setDoc(doc(db, 'tournaments', currentEventId, 'bracket', 'data'), {
          matches: processedMatches,
          mappings: previewData.mappings,
          updatedAt: serverTimestamp()
        }).catch(err => console.error("Error saving tournaments bracket data:", err));
      }
      
      // Calculate ring totals
      const ringTotals = new Map<number, number>();
      processedMatches.forEach(m => {
        const boutNum = parseInt(m.bout.toString().replace(/[^0-9]/g, ''));
        if (!isNaN(boutNum)) {
          const currentMax = ringTotals.get(m.ring) || 0;
          if (boutNum > currentMax) ringTotals.set(m.ring, boutNum);
        }
      });

      // Check mappings for higher bout numbers too
      previewData.mappings.forEach(m => {
        const sourceStr = (m.sourceBout || '').toString();
        const nextStr = (m.nextBout || '').toString();
        const sourceNum = parseInt(sourceStr.replace(/[^0-9]/g, '') || '0');
        const nextNum = parseInt(nextStr.replace(/[^0-9]/g, '') || '0');
        
        const matchingSource = processedMatches.find((match: MatchData) => isBoutMatch(match.bout, m.sourceBout));
        const matchingNext = processedMatches.find((match: MatchData) => isBoutMatch(match.bout, m.nextBout));
        
        const sRing = matchingSource ? matchingSource.ring : getRingFromBout(sourceStr);
        const nRing = matchingNext ? matchingNext.ring : getRingFromBout(nextStr);

        if (sourceNum > (ringTotals.get(sRing) || 0)) ringTotals.set(sRing, sourceNum);
        if (nextNum > (ringTotals.get(nRing) || 0)) ringTotals.set(nRing, nextNum);
      });

      // 2. Update Rings: Load first 3 matches directly to active rings slots (currentBout, onDeck, inTheHole) 
      const assignedMatchIds = new Set<string>();

      const updatedRings = rings.map(r => {
        const ringMatches = processedMatches.filter(m => m.ring === r.ringNumber);
        
        let ringChanged = false;
        let currentBout = r.currentBout;
        let onDeck = r.onDeck;
        let inTheHole = r.inTheHole;
        
        const total = ringTotals.get(r.ringNumber);
        const nextMaxTotal = total !== undefined ? total : r.totalBouts;

        const isCurrentBoutEmpty = !currentBout || !currentBout.blue_name || currentBout.eventId !== currentEventId;
        const isOnDeckEmpty = !onDeck || !onDeck.blue_name || onDeck.eventId !== currentEventId;
        const isInTheHoleEmpty = !inTheHole || !inTheHole.blue_name || inTheHole.eventId !== currentEventId;

        let availableMatchIndex = 0;

        // Load or update currentBout: We keep the current active bout as null (idle) initially if empty, so the 1st bout goes to the upcoming (onDeck) slot instead.
        if (isCurrentBoutEmpty) {
          currentBout = null;
          ringChanged = true;
        } else {
          const match = ringMatches.find(m => isBoutMatch(m.bout, currentBout!.bout));
          if (match) {
            currentBout = { ...currentBout, ...match };
            assignedMatchIds.add(match.bout.toString());
            ringChanged = true;
          }
        }

        // Load or update onDeck
        if (isOnDeckEmpty) {
          if (availableMatchIndex < ringMatches.length) {
            onDeck = ringMatches[availableMatchIndex];
            assignedMatchIds.add(onDeck.bout.toString());
            availableMatchIndex++;
            ringChanged = true;
          } else {
            onDeck = null;
            ringChanged = true;
          }
        } else {
          const match = ringMatches.find(m => isBoutMatch(m.bout, onDeck!.bout));
          if (match) {
            onDeck = { ...onDeck, ...match };
            assignedMatchIds.add(match.bout.toString());
            ringChanged = true;
          }
        }

        // Load or update inTheHole
        if (isInTheHoleEmpty) {
          if (availableMatchIndex < ringMatches.length) {
            inTheHole = ringMatches[availableMatchIndex];
            assignedMatchIds.add(inTheHole.bout.toString());
            availableMatchIndex++;
            ringChanged = true;
          } else {
            inTheHole = null;
            ringChanged = true;
          }
        } else {
          const match = ringMatches.find(m => isBoutMatch(m.bout, inTheHole!.bout));
          if (match) {
            inTheHole = { ...inTheHole, ...match };
            assignedMatchIds.add(match.bout.toString());
            ringChanged = true;
          }
        }

        // Keep nextBoutNumber pointed correctly
        let nextBoutNo = r.nextBoutNumber || 1;
        if (currentBout) {
          nextBoutNo = getBoutNumber(currentBout.bout) + 1;
        }

        return {
          ...r,
          totalBouts: nextMaxTotal,
          currentBout,
          onDeck,
          inTheHole,
          nextBoutNumber: nextBoutNo,
          isFinalBouts: r.isFinalBouts || false,
          version: (r.version || 0) + 1,
          updatedAt: Date.now()
        };
      });

      localStorage.setItem('tkd_rings', JSON.stringify(updatedRings));
      setRings(updatedRings);
      
      // 3. Update Bout Queue (add only unassigned standby matches to the standby queue to prevent active court duplication)
      setBoutQueue(prev => {
        const unassignedMatches = processedMatches.filter(m => !assignedMatchIds.has(m.bout.toString()));

        const newBouts = unassignedMatches.map(m => ({
          id: Math.random().toString(36).substr(2, 9),
          data: m
        }));
        
        const updatedQueue = [...prev];
        
        newBouts.forEach(nb => {
          const existingIndex = updatedQueue.findIndex(pb => 
            pb.data.ring === nb.data.ring && 
            pb.data.eventId === currentEventId &&
            isBoutMatch(pb.data.bout, nb.data.bout)
          );
          
          if (existingIndex !== -1) {
            // Overwrite details of the existing placeholder match while keeping its unique ID and base properties
            const existingBout = updatedQueue[existingIndex];
            updatedQueue[existingIndex] = {
              ...existingBout,
              data: {
                ...existingBout.data,
                ...nb.data,
                bout: typeof existingBout.data.bout === 'number' || /^\d+$/.test(existingBout.data.bout.toString())
                  ? normalizeBoutWithRing(nb.data.bout, nb.data.ring)
                  : nb.data.bout
              }
            };
          } else {
            updatedQueue.push(nb);
          }
        });
        
        localStorage.setItem('tkd_bout_queue', JSON.stringify(updatedQueue));
        return updatedQueue;
      });

      await Promise.all(mappingPromises);
      
      // Save local backup mapping per ring
      const mappingsByRing: Record<string, BoutMapping[]> = {};
      previewData.mappings.forEach(m => {
        const sourceStr = (m.sourceBout || '').toString();
        
        const matchingMatch = processedMatches.find((match: MatchData) => 
          isBoutMatch(match.bout, m.sourceBout) || isBoutMatch(match.bout, m.nextBout)
        );
        const ringNum = matchingMatch ? matchingMatch.ring : getRingFromBout(sourceStr);
        const sRing = ringNum.toString();
        
        if (!mappingsByRing[sRing]) mappingsByRing[sRing] = [];
        const resolvedCategory = (m.categoryName || (matchingMatch ? matchingMatch.category : "Auto-Extracted from File")).toUpperCase().trim();
        
        mappingsByRing[sRing].push({
           ...m,
           sourceBout: normalizeBoutNumber(m.sourceBout || ''),
           nextBout: normalizeBoutNumber(m.nextBout || ''),
           eventId: currentEventId,
           eventName: currentEvent.name,
           categoryName: resolvedCategory
        });
      });

      const matchesByRing: Record<string, MatchData[]> = {};
      processedMatches.forEach(m => {
        const sRing = m.ring.toString();
        if (!matchesByRing[sRing]) matchesByRing[sRing] = [];
        matchesByRing[sRing].push(m);
      });
      
      setBackupData(prev => {
        const next = { ...prev };
        const allRings = new Set([...Object.keys(mappingsByRing), ...Object.keys(matchesByRing)]);
        allRings.forEach(sRing => {
           const key = `${currentEventId}_${sRing}`;
           next[key] = {
             mappings: mappingsByRing[sRing] || [],
             matches: matchesByRing[sRing] || []
           };
        });
        return next;
      });

      alert(`Bracket mappings and ${previewData.matches.length} matches successfully applied!\n\nCheck the Active Advancement Logic panel and the Match Queue.`);
      if (onSuccess) onSuccess();
      setPreviewData(null);
      setFile(null);
    } catch (err: any) {
      console.error("Apply Error:", err);
      setError("Failed to save mappings to the system.");
      if (err.code === 'resource-exhausted' || err.message?.toLowerCase().includes('quota')) {
        handleGlobalQuotaTrigger();
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const syncToSheet = async () => {
    if (!previewData || !currentEvent) return;
    
    const sheetUrl = currentEvent.sheetUrl;
    if (!sheetUrl) {
      setError("No Google Sheet URL configured for this event. Please set it in Settings.");
      return;
    }

    setIsSyncing(true);
    try {
      let successCount = 0;
      for (const match of previewData.matches) {
        const success = await syncToGoogleSheets(sheetUrl, match, currentEvent.name);
        if (success) successCount++;
      }
      alert(`Successfully synced ${successCount} matches to Google Sheets!`);
    } catch (err) {
      console.error("Sync Error:", err);
      setError("Failed to sync matches to Google Sheets.");
    } finally {
      setIsSyncing(false);
    }
  };

  const downloadMatchesCSV = () => {
    if (!previewData) return;
    
    const headers = ["Bout #", "Category", "Blue Player", "Blue Club", "Red Player", "Red Club"];
    const rows = previewData.matches.map(m => [
      formatBoutNumber(m.ring || 1, m.bout, boutNumberingMode),
      m.category,
      m.blue_name,
      m.blue_club,
      m.red_name,
      m.red_club
    ]);
    
    const csvContent = [headers, ...rows].map(e => e.join(",")).join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `matches_${currentEvent?.name || 'export'}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      <AnimatePresence>
        {showDuplicateModal && pendingFile && (
          <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-3xl p-8 max-w-md w-full shadow-2xl"
            >
              <div className="w-16 h-16 bg-amber-100 rounded-2xl flex items-center justify-center mb-6 mx-auto">
                <AlertCircle size={32} className="text-amber-600" />
              </div>
              <h3 className="text-xl font-black text-center text-slate-900 mb-2">Duplicate File Detected</h3>
              <p className="text-slate-500 text-center mb-8">
                You have already processed a file named <strong className="text-slate-700">"{pendingFile.name}"</strong> with the same size. Are you sure you want to upload it again?
              </p>
              <div className="flex gap-4">
                <button 
                  onClick={() => {
                    setShowDuplicateModal(false);
                    setPendingFile(null);
                  }}
                  className="flex-1 px-6 py-3 bg-slate-100 text-slate-700 font-bold rounded-xl hover:bg-slate-200 transition-colors"
                >
                  Cancel
                </button>
                <button 
                  onClick={() => {
                    acceptFile(pendingFile);
                    setShowDuplicateModal(false);
                    setPendingFile(null);
                  }}
                  className="flex-1 px-6 py-3 bg-amber-500 text-white font-bold rounded-xl hover:bg-amber-600 transition-colors"
                >
                  Upload Anyway
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <div className="bg-white rounded-[2.5rem] p-8 border border-slate-200 shadow-sm">
        <div className="flex items-center gap-4 mb-8">
          <div className="w-12 h-12 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-900/20">
            <RefreshCw size={24} className="text-white" />
          </div>
          <div>
            <h2 className="text-2xl font-black text-slate-900 uppercase tracking-tight italic">AI Bracket Setup</h2>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">Upload PDF/Image to auto-generate matches & mappings</p>
          </div>
        </div>

        {!currentEventId ? (
          <div className="p-12 bg-indigo-50 border-2 border-dashed border-indigo-200 rounded-[2rem] text-center space-y-6">
            <div className="w-20 h-20 bg-indigo-100 rounded-3xl flex items-center justify-center mx-auto">
              <RefreshCw className="text-indigo-600 animate-spin-slow" size={40} />
            </div>
            <div className="space-y-2">
              <h3 className="text-2xl font-black text-indigo-900 uppercase tracking-tight italic">Select Active Event</h3>
              <p className="text-sm text-indigo-700 font-medium">To use AI Setup, please link this session to a tournament event first.</p>
            </div>
            
            <div className="flex flex-col items-center gap-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-lg mx-auto">
                {events.map((e, idx) => (
                  <button
                    key={`${e.id}-${idx}`}
                    onClick={() => onSelectEvent?.(e.id)}
                    className="p-4 bg-white border border-indigo-100 rounded-2xl text-left hover:border-indigo-400 hover:shadow-lg transition-all group"
                  >
                    <p className="text-xs font-black text-indigo-600 uppercase tracking-widest mb-1 group-hover:text-indigo-700">{e.ringQuantity} Rings</p>
                    <p className="text-sm font-bold text-slate-800">{e.name}</p>
                  </button>
                ))}
              </div>
              
              {events.length === 0 && (
                <div className="p-4 bg-white/50 border border-indigo-100 rounded-xl">
                  <p className="text-xs font-bold text-indigo-500">No events found. Create one in Settings &gt; Event Management.</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-8">
            {/* Upload Area */}
            <div 
              onClick={() => fileInputRef.current?.click()}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={cn(
                "p-12 border-4 border-dashed rounded-[3rem] text-center cursor-pointer transition-all group",
                isDragging ? "border-indigo-400 bg-indigo-50 scale-[1.02]" :
                file ? "border-green-200 bg-green-50" : "border-slate-100 bg-slate-50 hover:border-indigo-200 hover:bg-indigo-50"
              )}
            >
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileChange} 
                onClick={(e) => { (e.target as HTMLInputElement).value = '' }}
                className="hidden" 
                accept=".pdf,.png,.jpg,.jpeg,.csv,.xlsx"
              />
              
              {file || (previewData && previewData.fileName) ? (
                <div className="space-y-4">
                  <div className="w-20 h-20 bg-green-600 rounded-3xl flex items-center justify-center mx-auto shadow-xl shadow-green-900/20">
                    {(file?.type || previewData?.fileType || '').includes('pdf') ? <FileText size={40} className="text-white" /> : <FileIcon size={40} className="text-white" />}
                  </div>
                  <div>
                    <p className="text-xl font-black text-slate-900">{file?.name || previewData?.fileName}</p>
                    <p className="text-sm font-bold text-green-600 uppercase tracking-widest mt-1">
                      {file ? "File Ready for Processing" : "Previously Analyzed Results"}
                    </p>
                  </div>
                  <button 
                    onClick={(e) => { e.stopPropagation(); clearResults(); }}
                    className="text-xs font-bold text-slate-400 hover:text-red-600 uppercase tracking-widest flex items-center gap-1 mx-auto"
                  >
                    <X size={14} /> {file ? "Remove File" : "Clear Results"}
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="w-20 h-20 bg-slate-200 rounded-3xl flex items-center justify-center mx-auto group-hover:bg-indigo-600 transition-colors">
                    <Upload size={40} className="text-slate-400 group-hover:text-white transition-colors" />
                  </div>
                  <div>
                    <p className="text-xl font-black text-slate-900">Drop Bracket PDF or Image here</p>
                    <p className="text-sm font-bold text-slate-400 uppercase tracking-widest mt-1">Supports PDF, PNG, JPG, CSV, Excel</p>
                  </div>
                </div>
              )}
            </div>

            {error && (
              <div className="p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-600 text-sm font-bold">
                <AlertCircle size={20} />
                {error}
              </div>
            )}

            {/* AI Settings */}
            <div className="flex flex-wrap items-center gap-6 p-6 bg-white rounded-3xl border border-slate-200 shadow-sm">
              <div className="flex items-center gap-3">
                <div className={cn(
                  "w-10 h-10 rounded-xl flex items-center justify-center transition-all",
                  isThinkingMode ? "bg-indigo-600 text-white shadow-lg shadow-indigo-200" : "bg-slate-100 text-slate-400"
                )}>
                  <Sparkles size={20} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-black uppercase tracking-widest text-slate-900">Deep Thinking Mode</span>
                    <button 
                      onClick={() => setIsThinkingMode(!isThinkingMode)}
                      className={cn(
                        "w-10 h-5 rounded-full relative transition-all",
                        isThinkingMode ? "bg-indigo-600" : "bg-slate-200"
                      )}
                    >
                      <div className={cn(
                        "absolute top-1 w-3 h-3 bg-white rounded-full transition-all",
                        isThinkingMode ? "left-6" : "left-1"
                      )} />
                    </button>
                  </div>
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">
                    {isThinkingMode ? "Using Pro Model + Reasoning (Slower, More Accurate)" : "Using Flash Model (Faster, Standard Accuracy)"}
                  </p>
                </div>
              </div>

              <div className="h-8 w-px bg-slate-100 hidden md:block" />

              <div className="flex items-center gap-3">
                <div className={cn(
                  "w-10 h-10 rounded-xl flex items-center justify-center transition-all",
                  isPoomsaeMode ? "bg-purple-600 text-white shadow-lg shadow-purple-200" : "bg-slate-100 text-slate-400"
                )}>
                  <Zap size={20} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-black uppercase tracking-widest text-slate-900">Individual Poomsae Mode</span>
                    <button 
                      onClick={() => setIsPoomsaeMode(!isPoomsaeMode)}
                      className={cn(
                        "w-10 h-5 rounded-full relative transition-all",
                        isPoomsaeMode ? "bg-purple-600" : "bg-slate-200"
                      )}
                    >
                      <div className={cn(
                        "absolute top-1 w-3 h-3 bg-white rounded-full transition-all",
                        isPoomsaeMode ? "left-6" : "left-1"
                      )} />
                    </button>
                  </div>
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">Map every player as a sequential performance (e.g. 1, 2, 3...)</p>
                </div>
              </div>
            </div>

            {/* Admin Note Section */}
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Additional Instructions for AI (Optional)</label>
              <textarea 
                value={adminNote}
                onChange={(e) => setAdminNote(e.target.value)}
                placeholder="e.g. Ignore the first page, or only extract matches for Ring 3, or names are written in a specific way..."
                className="w-full p-4 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-500 transition-all min-h-[100px] resize-none"
              />
            </div>

            <div className="flex justify-center">
              <button
                onClick={processFile}
                disabled={!file || isProcessing}
                className="px-12 py-5 bg-indigo-600 text-white rounded-[2rem] font-black uppercase tracking-widest hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400 transition-all shadow-xl shadow-indigo-200 flex items-center gap-3"
              >
                {isProcessing ? <RefreshCw size={24} className="animate-spin" /> : <GitBranch size={24} />}
                {isProcessing ? "Fast Analysis in Progress..." : "Analyze with AI (Fast)"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Preview Area */}
      <AnimatePresence>
        {previewData && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white rounded-[2.5rem] border border-slate-200 shadow-2xl overflow-hidden"
          >
            <div className="p-8 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-green-600 rounded-2xl flex items-center justify-center">
                  <CheckCircle2 size={24} className="text-white" />
                </div>
                <div>
                  <h3 className="text-xl font-black uppercase tracking-tight italic">AI Extraction Results</h3>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">Review before applying to system</p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex bg-white/10 p-1 rounded-xl">
                  <button 
                    onClick={() => setActivePreviewTab('matches')}
                    className={cn(
                      "px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all",
                      activePreviewTab === 'matches' ? "bg-white text-slate-900" : "text-slate-400 hover:text-white"
                    )}
                  >
                    Matches ({previewData.matches.length})
                  </button>
                  <button 
                    onClick={() => setActivePreviewTab('mappings')}
                    className={cn(
                      "px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all",
                      activePreviewTab === 'mappings' ? "bg-white text-slate-900" : "text-slate-400 hover:text-white"
                    )}
                  >
                    Mappings ({previewData.mappings.length})
                  </button>
                </div>
                <button 
                  onClick={clearResults}
                  className="p-2 text-slate-400 hover:text-red-400 transition-colors"
                  title="Clear Results"
                >
                  <X size={20} />
                </button>
              </div>
            </div>

            <div className="p-8">
              {activePreviewTab === 'matches' ? (
                <div className="space-y-6">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-black text-slate-900 uppercase tracking-widest">Initial Matches Found</h4>
                    <div className="flex items-center gap-4">
                      <button 
                        onClick={refineWithAI}
                        disabled={isProcessing}
                        className="flex items-center gap-2 text-xs font-black text-amber-600 uppercase tracking-widest hover:text-amber-700 disabled:opacity-50"
                      >
                        {isProcessing ? <RefreshCw size={16} className="animate-spin" /> : <Sparkles size={16} />}
                        Refine with AI
                      </button>
                      <button 
                        onClick={syncToSheet}
                        disabled={isSyncing}
                        className="flex items-center gap-2 text-xs font-black text-green-600 uppercase tracking-widest hover:text-green-700 disabled:opacity-50"
                      >
                        {isSyncing ? <RefreshCw size={16} className="animate-spin" /> : <Send size={16} />}
                        Sync to Google Sheet
                      </button>
                      <button 
                        onClick={downloadMatchesCSV}
                        className="flex items-center gap-2 text-xs font-black text-indigo-600 uppercase tracking-widest hover:text-indigo-700"
                      >
                        <FileSpreadsheet size={16} /> Download CSV
                      </button>
                    </div>
                  </div>
                  <div className="overflow-x-auto rounded-2xl border border-slate-100">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-100">
                          <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Bout #</th>
                          <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Category</th>
                          <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">{isPoomsaeMode ? 'Performer' : 'Blue Player'}</th>
                          {!isPoomsaeMode && <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Red Player</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {previewData.matches.map((m, i) => (
                          <tr key={i} className="hover:bg-slate-50 transition-colors">
                            <td className="px-6 py-4">
                              <input 
                                type="text" 
                                value={formatBoutNumber(m.ring || 1, m.bout, boutNumberingMode)} 
                                onChange={(e) => handleMatchEdit(i, 'bout', e.target.value)}
                                className="w-16 text-sm font-black text-slate-900 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-indigo-500 outline-none transition-colors"
                              />
                            </td>
                            <td className="px-6 py-4">
                              <input 
                                type="text" 
                                value={m.category || ''} 
                                onChange={(e) => handleMatchEdit(i, 'category', e.target.value)}
                                className="w-full text-xs font-bold text-slate-500 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-indigo-500 outline-none transition-colors"
                              />
                            </td>
                            <td className="px-6 py-4">
                              <input 
                                type="text" 
                                value={m.blue_name || ''} 
                                onChange={(e) => handleMatchEdit(i, 'blue_name', e.target.value)}
                                placeholder={isPoomsaeMode ? "Performer Name" : "Blue Name"}
                                className={cn(
                                  "w-full text-sm font-black bg-transparent border-b border-transparent outline-none transition-colors mb-1",
                                  isPoomsaeMode ? "text-slate-900 hover:border-slate-300 focus:border-slate-500" : "text-blue-600 hover:border-blue-300 focus:border-blue-500"
                                )}
                              />
                              <input 
                                type="text" 
                                value={m.blue_club || ''} 
                                onChange={(e) => handleMatchEdit(i, 'blue_club', e.target.value)}
                                placeholder={isPoomsaeMode ? "Performer Club" : "Blue Club"}
                                className={cn(
                                  "w-full text-[10px] font-bold uppercase bg-transparent border-b border-transparent outline-none transition-colors",
                                  isPoomsaeMode ? "text-slate-500 hover:border-slate-300 focus:border-slate-500" : "text-slate-400 hover:border-slate-300 focus:border-blue-500"
                                )}
                              />
                            </td>
                            {!isPoomsaeMode && (
                              <td className="px-6 py-4">
                                <input 
                                  type="text" 
                                  value={m.red_name || ''} 
                                  onChange={(e) => handleMatchEdit(i, 'red_name', e.target.value)}
                                  placeholder="Red Name"
                                  className="w-full text-sm font-black text-red-600 bg-transparent border-b border-transparent hover:border-red-300 focus:border-red-500 outline-none transition-colors mb-1"
                                />
                                <input 
                                  type="text" 
                                  value={m.red_club || ''} 
                                  onChange={(e) => handleMatchEdit(i, 'red_club', e.target.value)}
                                  placeholder="Red Club"
                                  className="w-full text-[10px] font-bold text-slate-400 uppercase bg-transparent border-b border-transparent hover:border-slate-300 focus:border-red-500 outline-none transition-colors"
                                />
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="space-y-6">
                  <h4 className="text-sm font-black text-slate-900 uppercase tracking-widest">Advancement Logic Found</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {previewData.mappings.map((m, i) => (
                      <div key={i} className="p-4 bg-slate-50 rounded-2xl border border-slate-100 flex items-center justify-between group hover:border-indigo-200 transition-all">
                        <div className="flex items-center gap-3">
                          <div className="w-12 h-10 bg-white rounded-xl border border-slate-200 flex items-center justify-center shadow-sm">
                            <input 
                              type="text" 
                              value={formatBoutNumber(1, m.sourceBout || '', boutNumberingMode)} 
                              onChange={(e) => handleMappingEdit(i, 'sourceBout', e.target.value)}
                              className="w-full text-center font-black text-slate-900 bg-transparent outline-none"
                            />
                          </div>
                          <ChevronRight size={16} className="text-slate-300" />
                          <div className="w-12 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-900/20">
                            <input 
                              type="text" 
                              value={formatBoutNumber(1, m.nextBout || '', boutNumberingMode)} 
                              onChange={(e) => handleMappingEdit(i, 'nextBout', e.target.value)}
                              className="w-full text-center font-black text-white bg-transparent outline-none placeholder-indigo-300"
                            />
                          </div>
                        </div>
                        <select 
                          value={m.slot || 'Chung'} 
                          onChange={(e) => handleMappingEdit(i, 'slot', e.target.value)}
                          className={cn(
                            "px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest outline-none cursor-pointer border-none",
                            m.slot === 'Chung' ? "bg-blue-100 text-blue-600" : "bg-red-100 text-red-600"
                          )}
                        >
                          <option value="Chung">CHUNG</option>
                          <option value="Hong">HONG</option>
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Total Bouts Summary */}
              <div className="bg-slate-50 p-6 rounded-3xl border border-slate-200">
                <h4 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-4 flex items-center gap-2">
                  <Trophy size={18} className="text-red-600" />
                  Calculated Total Bouts Per Ring
                </h4>
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
                  {(() => {
                    const ringTotals = new Map<number, number>();
                    
                    const getRingFromBout = (bout: string) => {
                      const boutNum = parseInt(bout.replace(/[^0-9]/g, ''));
                      if (!isNaN(boutNum) && boutNum >= 1000) {
                        return Math.floor(boutNum / 1000);
                      }
                      const prefix = bout.charAt(0).toUpperCase();
                      if (prefix === 'A') return 1;
                      if (prefix === 'B') return 2;
                      if (prefix === 'C') return 3;
                      if (prefix === 'D') return 4;
                      if (prefix === 'E') return 5;
                      if (prefix === 'F') return 6;
                      if (prefix === 'G') return 7;
                      if (prefix === 'H') return 8;
                      return 1;
                    };

                    previewData.matches.forEach(m => {
                      const boutStr = (m.bout || '').toString();
                      const boutNum = parseInt(boutStr.replace(/[^0-9]/g, ''));
                      const ringNum = Number(m.ring || getRingFromBout(boutStr));
                      if (!isNaN(boutNum)) {
                        const currentMax = ringTotals.get(ringNum) || 0;
                        if (boutNum > currentMax) ringTotals.set(ringNum, boutNum);
                      }
                    });

                    previewData.mappings.forEach(m => {
                      const sourceStr = (m.sourceBout || '').toString();
                      const nextStr = (m.nextBout || '').toString();
                      const sourceNum = parseInt(sourceStr.replace(/[^0-9]/g, '') || '0');
                      const nextNum = parseInt(nextStr.replace(/[^0-9]/g, '') || '0');
                      
                      const matchingSource = previewData.matches.find((match: MatchData) => isBoutMatch(match.bout, m.sourceBout));
                      const matchingNext = previewData.matches.find((match: MatchData) => isBoutMatch(match.bout, m.nextBout));

                      const sRing = matchingSource ? Number(matchingSource.ring || getRingFromBout(sourceStr)) : getRingFromBout(sourceStr);
                      const nRing = matchingNext ? Number(matchingNext.ring || getRingFromBout(nextStr)) : getRingFromBout(nextStr);

                      if (sourceNum > (ringTotals.get(sRing) || 0)) ringTotals.set(sRing, sourceNum);
                      if (nextNum > (ringTotals.get(nRing) || 0)) ringTotals.set(nRing, nextNum);
                    });

                    return Array.from(ringTotals.entries())
                      .sort(([a], [b]) => a - b)
                      .map(([ringNum, maxBout]) => (
                        <div key={ringNum} className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm">
                          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Ring {ringNum}</p>
                          <p className="text-xl font-black text-slate-800">{maxBout}</p>
                        </div>
                      ));
                  })()}
                </div>
              </div>

              <div className="mt-12 flex flex-col items-center gap-4">
                <p className="text-xs font-bold text-slate-500 text-center max-w-md">
                  Applying will save the **Advancement Mappings** and load the **Initial Players** into the Match Queue. 
                  You can also sync these to your Google Sheet using the button in the Results section.
                </p>
                <button 
                  onClick={handleApply}
                  disabled={isProcessing}
                  className="px-12 py-5 bg-green-600 text-white rounded-[2rem] font-black uppercase tracking-widest hover:bg-green-700 transition-all shadow-xl shadow-green-200 flex items-center gap-3"
                >
                  {isProcessing ? <RefreshCw size={24} className="animate-spin" /> : <Save size={24} />}
                  Apply Mappings to System
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
