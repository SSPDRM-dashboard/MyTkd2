const fs = require('fs');

const path = 'src/App.tsx';
let code = fs.readFileSync(path, 'utf8');

// The `StandbyView` component starts at line 4763
const startKeyword = 'function StandbyView({ rings';
const startIndex = code.indexOf(startKeyword);

// Find the end of `StandbyView`
// It ends at `function OnsiteView`
const endKeyword = 'function OnsiteView({ rings';
const endIndex = code.indexOf(endKeyword);

const standbyViewCode = code.slice(startIndex, endIndex);

// Change `StandbyView` to `PointsView`
let pointViewCode = standbyViewCode.replace(/function StandbyView/g, 'function PointsView');
pointViewCode = pointViewCode.replace(/"Standby View"/g, '"Points View"');
pointViewCode = pointViewCode.replace(/Live Tournament Standby Monitoring/g, 'Live Tournament Points Monitoring');

// We need to add "3 round points" columns to `PointsView`
// Look for where the player names are rendered in the `left: Current Match`
const playersRegex = /\{\/\* Players \*\/\}([\s\S]*?)\{\/\* Center: Ring Info \*\/\}/m;

// Replace it with point table
const playersReplacement = `{/* Players & Points */}
                      <div className="col-span-10 grid grid-cols-12 h-full">
                        <div className="col-span-6 flex flex-col">
                          <div className={cn(
                            "flex-1 bg-blue-600/90 flex flex-col justify-center px-4 relative",
                            !isPoomsaeModeCurrent && "border-b border-white/10"
                          )}>
                            <p className="text-[15px] font-bold text-black uppercase leading-none mb-1">{current ? cleanPlaceholder(current.blue_club || "") : "---"}</p>
                            <h4 className="text-[30px] font-black text-white uppercase leading-none truncate">{current ? cleanPlaceholder(current.blue_name || "") : "---"}</h4>
                          </div>
                          {!isPoomsaeModeCurrent && (
                            <div className="flex-1 bg-red-600/90 flex flex-col justify-center px-4 relative">
                              <p className="text-[15px] font-bold text-black uppercase leading-none mb-1">{current ? cleanPlaceholder(current.red_club || "") : "---"}</p>
                              <h4 className="text-[30px] font-black text-white uppercase leading-none truncate">{current ? cleanPlaceholder(current.red_name || "") : "---"}</h4>
                            </div>
                          )}
                        </div>
                        <div className="col-span-6 flex flex-col border-l border-white/10 bg-[#0d1526]">
                          {/* Point columns */}
                          <div className="flex-1 flex flex-col border-b border-white/10">
                            <div className="flex-1 grid grid-cols-3 divide-x divide-white/10">
                              <div className="flex items-center justify-center font-black text-3xl text-[#00a2e8]">{current?.points?.r1Blue || '-'}</div>
                              <div className="flex items-center justify-center font-black text-3xl text-[#00a2e8]">{current?.points?.r2Blue || '-'}</div>
                              <div className="flex items-center justify-center font-black text-3xl text-[#00a2e8]">{current?.points?.r3Blue || '-'}</div>
                            </div>
                          </div>
                          {!isPoomsaeModeCurrent && (
                            <div className="flex-1 flex flex-col">
                              <div className="flex-1 grid grid-cols-3 divide-x divide-white/10">
                                <div className="flex items-center justify-center font-black text-3xl text-[#ed1c24]">{current?.points?.r1Red || '-'}</div>
                                <div className="flex items-center justify-center font-black text-3xl text-[#ed1c24]">{current?.points?.r2Red || '-'}</div>
                                <div className="flex items-center justify-center font-black text-3xl text-[#ed1c24]">{current?.points?.r3Red || '-'}</div>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                      {/* Center: Ring Info */}`;

pointViewCode = pointViewCode.replace(playersRegex, playersReplacement);

// Inject `PointsView` below `StandbyView`
code = code.slice(0, endIndex) + pointViewCode + '\n\n' + code.slice(endIndex);

fs.writeFileSync(path, code);
console.log("Replaced");
