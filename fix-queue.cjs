const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

code = code.replace(/\{ringQueue(?: \|\| \[\])?\.map\(\(item, idx\) => \(/g, '{ringQueue?.map((item, idx) => (');
code = code.replace(/<div key=\{item\.id\}/g, '<div key={`${item.id}-${idx}`}');

fs.writeFileSync('src/App.tsx', code);
console.log('Fixed item.id in App.tsx');
