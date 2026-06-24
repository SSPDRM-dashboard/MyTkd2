import { initializeApp } from 'firebase/app';
import { getFirestore, getDoc, setDoc, doc, collection, getDocs } from 'firebase/firestore';
import fs from 'fs';
import Papa from 'papaparse';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

const CSV_URL = 'https://docs.google.com/spreadsheets/d/14TrlxR_rk9S7WmdanXGLlE4Y-ry9TqY6_B6HYA0Uuus/export?format=csv';

function normalize(str: string) {
  return str.replace(/[^0-9]/g, '');
}

async function run() {
  // Map event names to their IDs
  const eventsDoc = await getDoc(doc(db, 'sync', 'tkd_events_v3'));
  const events = eventsDoc.exists() ? eventsDoc.data().value : [];
  const eventNameToId: Record<string, string> = {};
  for (const e of events) {
    if (e.name) {
       eventNameToId[e.name.toLowerCase().replace(/\s+/g, '')] = e.id;
    }
  }

  // Get active match history for all events
  const historySnap = await getDocs(collection(db, 'matchHistory'));
  const historyBouts = new Set();
  historySnap.forEach(d => {
    const data = d.data();
    if (data.eventId && data.bout) {
      historyBouts.add(data.eventId + "_" + normalize(data.bout) + "-" + data.ring);
    }
  });

  const response = await fetch(CSV_URL);
  const text = await response.text();
  const result = Papa.parse(text, { skipEmptyLines: true });
  const rows = result.data as string[][];

  let newQueue: any[] = [];
  const stats: any = {};

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length < 5) continue;
    
    // Check Event Name
    const rawEvtName = row[1]?.trim();
    if (!rawEvtName) continue;
    
    const evtKey = rawEvtName.toLowerCase().replace(/\s+/g, '');
    let eventId = eventNameToId[evtKey];
    
    // If we can't find the event ID for this row, we can't accurately add it to the queue
    if (!eventId) {
       if (rawEvtName === 'KEDAH OPEN TAEKWONDO CHAMPIONSHIP 2024') {
          // Hardcoded old events if necessary
          eventId = 'o6nsg2u9k';
       } else {
          continue;
       }
    }
    
    let ringStr = row[2]?.trim();
    const ringNum = parseInt(ringStr.replace(/[^0-9]/g, '')) || 1;
    let rawBout = row[3]?.trim();
    const cleanBout = normalize(rawBout);
    
    // Skip if it is in matchHistory for that event
    if (historyBouts.has(eventId + "_" + cleanBout + "-" + ringNum)) {
      continue; // already finished
    }

    newQueue.push({
      id: Math.random().toString(36).substring(2, 10),
      data: {
        ring: ringNum,
        bout: cleanBout,
        category: row[4],
        blue_name: row[5],
        blue_club: row[6],
        red_name: row[7],
        red_club: row[8],
        privacy_mode: false,
        eventId: eventId
      }
    });

    stats[eventId] = (stats[eventId] || 0) + 1;
  }

  console.log("Restoring " + newQueue.length + " total bouts across events.", stats);
  
  await setDoc(doc(db, 'sync', 'tkd_bout_queue'), { value: newQueue });
  console.log("Global Queue overwritten successfully.");
  process.exit(0);
}
run();
