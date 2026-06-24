const fs = require('fs');
let code = fs.readFileSync('src/components/BoutChart.tsx', 'utf8');

code = code.replace(/\{nodes\.map\(node => \{/g, '{nodes.map((node, i) => {');
code = code.replace(/key=\{node\.id\}/g, 'key={`${node.id}-${i}`}');

code = code.replace(/\{edges\.map\(e => \{/g, '{edges.map((e, i) => {');
code = code.replace(/key=\{e\.id\}/g, 'key={`${e.id}-${i}`}');

fs.writeFileSync('src/components/BoutChart.tsx', code);
console.log('Fixed BoutChart.tsx');
