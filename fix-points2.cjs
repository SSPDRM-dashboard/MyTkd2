const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

const ptIndex = code.indexOf('function PointsView');
const onsiteIndex = code.indexOf('function OnsiteView');

if (ptIndex !== -1 && onsiteIndex !== -1) {
    let ptView = code.slice(ptIndex, onsiteIndex);
    
    // 1. Remove "inspected" blocks in ptView
    // blue
    ptView = ptView.replace(/\{b\?\.data\.blue_inspected[\s\S]*?INSPECTED<\/span>\s*<\/div>\s*\)\}/g, '');
    
    // red
    ptView = ptView.replace(/\{b\?\.data\.red_inspected[\s\S]*?INSPECTED<\/span>\s*<\/div>\s*\)\}/g, '');

    // 2. Resize middle column and text, resize right column to give more space to active table
    ptView = ptView.replace(
        'className="flex-[3] flex flex-col bg-[#0d1526]',
        'className="flex-[4] flex flex-col bg-[#0d1526]'
    );
    
    ptView = ptView.replace(
        '<div className="flex-1 flex flex-col items-center justify-center">\\n                <span className="text-9xl',
        '<div className="flex-[0.5] flex flex-col items-center justify-center">\\n                <span className="text-6xl'
    );
    // simpler replace for middle col:
    ptView = ptView.replace(
        '<div className="flex-1 flex flex-col items-center justify-center">\n                <span className="text-9xl font-black text-white italic tracking-tighter leading-none">{ringName}</span>\n                <span className="text-[18px] font-black text-white uppercase tracking-[0.5em] mt-4">COURT</span>\n              </div>',
        '<div className="flex-[0.5] flex flex-col items-center justify-center">\n                <span className="text-6xl font-black text-white italic tracking-tighter leading-none">{ringName}</span>\n                <span className="text-[12px] font-black text-white uppercase tracking-[0.5em] mt-2">COURT</span>\n              </div>'
    );
    
    ptView = ptView.replace(
        '<div className="flex-[2] flex flex-col gap-1">',
        '<div className="flex-[1.5] flex flex-col gap-1">'
    );

    code = code.slice(0, ptIndex) + ptView + code.slice(onsiteIndex);
    fs.writeFileSync('src/App.tsx', code);
    console.log('Modified PointsView successfully');
} else {
    console.log('Could not find PointsView or OnsiteView');
}
