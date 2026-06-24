import fs from 'fs';
import Papa from 'papaparse';

const CSV_URL = 'https://docs.google.com/spreadsheets/d/14TrlxR_rk9S7WmdanXGLlE4Y-ry9TqY6_B6HYA0Uuus/export?format=csv';

async function run() {
  console.log("Fetching main tournament Google Sheet CSV from URL...");
  const response = await fetch(CSV_URL);
  const text = await response.text();
  console.log("Parsing CSV data...");
  const result = Papa.parse(text, { skipEmptyLines: true });
  const rows = result.data as string[][];

  console.log(`Successfully fetched and parsed. Total rows found: ${rows.length}`);
  if (rows.length === 0) {
    console.log("CSV has no rows.");
    process.exit(0);
  }

  // Let's print the headers
  const headers = rows[0];
  console.log("Headers:", headers);

  // We want to inspect:
  // Ring 1 Bout 1002 (or 2)
  // Ring 2 Bouts 2001, 2002 (or 1, 2)
  // Ring 3 Bouts 3001, 3002 (or 1, 2)
  // Let's print rows that match Ring 1, 2, or 3
  console.log("\nSearching for rows matching targets in sheet...");
  
  // Let's look for column indices:
  // Usually:
  // Day / Date
  // Ring / Court
  // Match No / Bout No
  // Category
  // Class
  // Blue Name
  // Blue Club
  // Red Name
  // Red Club
  // Winner / Result
  
  // Let's print the first 3 rows so we know the indexes
  console.log("\nSample rows to understand indexes:");
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    console.log(`Row [${i}]:`, rows[i]);
  }

  // Let's scan all rows
  let targetsFound = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    // We don't know the exact column indexes yet, so let's match any columns containing our target ring and bout values.
    // Let's scan cell values
    const ringVal = row[1]?.trim() || ""; // usually index 1 is Ring / Court
    const boutVal = row[3]?.trim() || ""; // usually index 3 is Match No / Bout No
    const blueName = row[5]?.trim() || "";
    const redName = row[7]?.trim() || "";
    const winner = row[9]?.trim() || ""; // winner/result is usually index 9 or 10

    const isRing1B2 = (ringVal === "1" && ["2", "1002"].includes(boutVal));
    const isRing2B1or2 = (ringVal === "2" && ["1", "2", "2001", "2002"].includes(boutVal));
    const isRing3B1or2 = (ringVal === "3" && ["1", "2", "3001", "3002"].includes(boutVal));

    if (isRing1B2 || isRing2B1or2 || isRing3B1or2) {
      targetsFound++;
      console.log(`\nRow [${i}] matches:`);
      row.forEach((cell, idx) => {
        console.log(`  Col ${idx} (${headers[idx]}): "${cell}"`);
      });
    }
  }

  console.log(`\nTotal target rows matched in spreadsheet: ${targetsFound}`);
  process.exit(0);
}

run();
