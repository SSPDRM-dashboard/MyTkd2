import { initializeApp } from 'firebase/app';
import { getFirestore, getDoc, doc } from 'firebase/firestore';
import fs from 'fs';
import Papa from 'papaparse';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

function getEventSpreadsheetUrl(event: any): string {
  if (!event) return '';
  return event.spreadsheetUrl || event.spreadsheet_url || event.sheetUrl || '';
}

async function run() {
  const currentEventDoc = await getDoc(doc(db, 'sync', 'tkd_current_event_v3'));
  let currentEventId = '';
  if (currentEventDoc.exists()) {
    currentEventId = currentEventDoc.data().value;
  }
  console.log("Current Event ID:", currentEventId);

  if (!currentEventId) {
    console.log("No current event scheduled.");
    process.exit(0);
  }

  const eventsDoc = await getDoc(doc(db, 'sync', 'tkd_events'));
  let activeSpreadsheetUrl = "https://docs.google.com/spreadsheets/d/14TrlxR_rk9S7WmdanXGLlE4Y-ry9TqY6_B6HYA0Uuus/export?format=csv";
  let eventName = '';

  if (eventsDoc.exists()) {
    const events = eventsDoc.data().value || [];
    const event = events.find((e: any) => e.id === currentEventId);
    if (event) {
      eventName = event.name || '';
      console.log("Found Active Event:", eventName);
      const resolvedSpreadsheet = getEventSpreadsheetUrl(event);
      if (resolvedSpreadsheet) {
        activeSpreadsheetUrl = resolvedSpreadsheet;
        if (!activeSpreadsheetUrl.includes('/export?')) {
          activeSpreadsheetUrl = activeSpreadsheetUrl.replace(/\/edit.*$/, '') + '/export?format=csv';
        }
      }
    } else {
      console.log(`Event with ID ${currentEventId} not found in tkd_events dynamic list. Using default URL.`);
    }
  }

  console.log("Selected Spreadsheet URL:", activeSpreadsheetUrl);

  const response = await fetch(activeSpreadsheetUrl);
  if (!response.ok) {
    console.log("Failed to fetch spreadsheet.");
    process.exit(0);
  }

  const csvText = await response.text();
  const results = Papa.parse<string[]>(csvText, { skipEmptyLines: true });
  const rows = results.data;
  console.log(`Spreadsheet has ${rows.length} total rows.`);

  const headers = rows[0];
  const dataRows = rows.slice(1);

  // Let's print out the search parameters for we are interested in.
  // We want to inspect:
  // Ring 1 Bout 2 / 1002
  // Ring 2 Bout 1, 2 / 2001, 2002
  // Ring 3 Bout 1, 2 / 3001, 3002
  console.log("\nSearching for matching target bouts in event spreadsheet...");
  
  // Normalization logic from app's codebase
  const cleanEvent = (name: string) => name.toLowerCase().replace(/\s+/g, '');
  const activeEventCleaned = cleanEvent(eventName);

  let targetMatches: any[] = [];
  dataRows.forEach((row, index) => {
    const rowEvent = row[1]?.trim() || "";
    const rowRing = row[2]?.trim() || "";
    const rowBout = row[3]?.trim() || "";

    if (cleanEvent(rowEvent) === activeEventCleaned) {
      const isRing1Bout2 = (rowRing === "1" && ["2", "1002", "B02", "B2"].includes(rowBout));
      const isRing2Bout1or2 = (rowRing === "2" && ["1", "2", "2001", "2002", "B01", "B02", "B1", "B2"].includes(rowBout));
      const isRing3Bout1or2 = (rowRing === "3" && ["1", "2", "3001", "3002", "C01", "C02", "C1", "C2"].includes(rowBout));

      if (isRing1Bout2 || isRing2Bout1or2 || isRing3Bout1or2) {
        targetMatches.push({
          rowNum: index + 2, // 1-based, +1 for header
          ring: rowRing,
          bout: rowBout,
          category: row[4],
          blue: row[5],
          blueClub: row[6],
          red: row[7],
          redClub: row[8],
          winner: row[15] || row[9] || "", // Check where winner column actually is
          fullRow: row
        });
      }
    }
  });

  console.log(`Found ${targetMatches.length} matching rows for Ring 1/2/3 target bouts:`);
  targetMatches.forEach(m => {
    console.log(`\nRow ${m.rowNum}: Ring ${m.ring} | Bout ${m.bout}`);
    console.log(`  Category : ${m.category}`);
    console.log(`  Blue     : ${m.blue} (${m.blueClub})`);
    console.log(`  Red      : ${m.red} (${m.redClub})`);
    console.log(`  Winner   : "${m.winner}"`);
    console.log(`  Full Row :`, m.fullRow);
  });

  process.exit(0);
}

run();
