import fs from 'fs';
import Papa from 'papaparse';

const CSV_URL = 'https://docs.google.com/spreadsheets/d/14TrlxR_rk9S7WmdanXGLlE4Y-ry9TqY6_B6HYA0Uuus/export?format=csv';

async function run() {
  const response = await fetch(CSV_URL);
  const text = await response.text();
  const result = Papa.parse(text, { skipEmptyLines: true });
  const rows = result.data as string[][];

  let eventCounts: any = {};
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const cat = row[1]?.trim() || "Empty";
    eventCounts[cat] = (eventCounts[cat] || 0) + 1;
  }
  console.log("Events in CSV:", eventCounts);
  process.exit(0);
}
run();
