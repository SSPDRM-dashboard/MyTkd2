const fs = require('fs');

const appTsxPaths = [
  'src/App.tsx',
  'src/components/AdminMapping.tsx',
  'src/components/EditBoutDetailsModal.tsx',
  'src/components/RingSummary.tsx',
  'src/components/EventReport.tsx'
];

appTsxPaths.forEach(p => {
  if (!fs.existsSync(p)) return;
  let code = fs.readFileSync(p, 'utf8');
  
  code = code.replace(/clubs\.map\(club => \(/g, 'clubs.map((club, i) => (');
  code = code.replace(/<option key={club} value={club}>{club}<\/option>/g, '<option key={`${club}-${i}`} value={club}>{club}</option>');

  code = code.replace(/events\.map\(e => \(/g, 'events.map((e, i) => (');
  code = code.replace(/events\.map\(\(e\) => \(/g, 'events.map((e, i) => (');
  code = code.replace(/events\.map\(ev => \(/g, 'events.map((ev, i) => (');
  
  code = code.replace(/<option key={e.id} value={e.id}>{e.name}<\/option>/g, '<option key={`${e.id}-${i}`} value={e.id}>{e.name}</option>');
  code = code.replace(/<option key={ev.id} value={ev.id}>{ev.name}<\/option>/g, '<option key={`${ev.id}-${i}`} value={ev.id}>{ev.name}</option>');
  code = code.replace(/<div key={ev.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-100">/g, '<div key={`${ev.id}-${i}`} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-100">');

  code = code.replace(/categories\.map\(cat => \(/g, 'categories.map((cat, i) => (');
  code = code.replace(/<option key={cat} value={cat}>{cat}<\/option>/g, '<option key={`${cat}-${i}`} value={cat}>{cat}</option>');
  
  code = code.replace(/fetchedCategories : categories\)\.map\(cat => \(/g, 'fetchedCategories : categories).map((cat, i) => (');

  fs.writeFileSync(p, code);
  console.log('Fixed', p);
});
