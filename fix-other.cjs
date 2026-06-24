const fs = require('fs');

let code1 = fs.readFileSync('src/components/AdminMapping.tsx', 'utf8');
code1 = code1.replace(/\{mappings\.filter\(m => m\.categoryName\?\.trim\(\) === selectedCategory\)\.map\(m => \(/g, '{mappings.filter(m => m.categoryName?.trim() === selectedCategory).map((m, i) => (');
code1 = code1.replace(/<tr key=\{m\.id\} /g, '<tr key={`${m.id}-${i}`} ');
fs.writeFileSync('src/components/AdminMapping.tsx', code1);

let code2 = fs.readFileSync('src/components/AIBracketSetup.tsx', 'utf8');
code2 = code2.replace(/\{events\.map\(e => \(/g, '{events.map((e, i) => (');
code2 = code2.replace(/key=\{e\.id\}/g, 'key={`${e.id}-${i}`}');
fs.writeFileSync('src/components/AIBracketSetup.tsx', code2);

console.log('Fixed other files');
