import { initializeApp } from 'firebase/app';
import { getFirestore, getDoc, doc } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

async function run() {
  const currentEventDoc = await getDoc(doc(db, 'sync', 'tkd_current_event_v3'));
  let currentEventId = '';
  if (currentEventDoc.exists()) {
    currentEventId = currentEventDoc.data().value;
  }
  console.log("Current Event ID:", currentEventId);

  const qDoc = await getDoc(doc(db, 'sync', 'tkd_bout_queue'));
  
  if (qDoc.exists()) {
    const queue = qDoc.data().value || [];
    console.log(`Total items in upcoming queue: ${queue.length}`);
    
    // Low numbered bouts we want to search for:
    const targetBouts = [
      { ring: "1", bouts: ["1001", "1002", "1003", "1004", "1005", "2", "02"] },
      { ring: "2", bouts: ["2001", "2002", "2003", "2004", "1", "2", "01", "02"] },
      { ring: "3", bouts: ["3001", "3002", "3003", "3004", "1", "2", "01", "02"] }
    ];

    console.log("\nSearching for target bouts in the queue...");
    
    // Find absolute match
    const foundTargets = queue.filter((item: any) => {
      const ringNumStr = String(item.data.ring || "").trim();
      const boutStr = String(item.data.bout || "").trim().toUpperCase();
      
      const matchConfig = targetBouts.find(t => t.ring === ringNumStr);
      if (matchConfig) {
        return matchConfig.bouts.includes(boutStr);
      }
      return false;
    });

    console.log(`Found ${foundTargets.length} matching bouts in the queue:`);
    foundTargets.forEach((item: any) => {
      console.log(`- Queue item: Ring ${item.data.ring}, Bout ${item.data.bout} (${item.data.blue_name} vs ${item.data.red_name}) [Status: ${item.data.status || 'unknown'}] [EventID: ${item.data.eventId || item.eventId}]`);
    });

    console.log("\nLet's also print standard matches for Ring 1, 2, 3 below 10 or 1010 to see what the starting numbers are:");
    const lowBouts = queue.filter((item: any) => {
      const ringNumStr = String(item.data.ring || "").trim();
      const boutStr = String(item.data.bout || "").trim().toUpperCase();
      // Parse bout number as integer if possible
      const numericPart = parseInt(boutStr.replace(/[^0-9]/g, ''));
      if (["1", "2", "3"].includes(ringNumStr)) {
        if (numericPart < 1010 || numericPart < 2010 || numericPart < 3010) {
          return true;
        }
      }
      return false;
    });

    // Sort by ring then bout number
    lowBouts.sort((a: any, b: any) => {
      const ringComp = String(a.data.ring).localeCompare(String(b.data.ring));
      if (ringComp !== 0) return ringComp;
      return String(a.data.bout).localeCompare(String(b.data.bout));
    });

    console.log(`\nFound ${lowBouts.length} lower bouts:`);
    lowBouts.forEach((item: any) => {
       console.log(`- Ring ${item.data.ring} | Bout ${item.data.bout} | ${item.data.blue_name} vs ${item.data.red_name}`);
    });

  } else {
    console.log("No queue document found.");
  }

  process.exit(0);
}

run();
