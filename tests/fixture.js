/* Small synthetic data set in the compact points.json schema used by the app. */
function fixture(over) {
  const d = {
    v: 1, fetched_at: "2026-10-01T00:00:00Z", mfm_version: "v1.0", hash: "aaaa",
    battle_sizes: [
      { id: "incursion", name: "Incursion", points: 1000, dp: 2, enh: 2, unit_limit: 2, single3dp: true },
      { id: "strikeforce", name: "Strike Force", points: 2000, dp: 3, enh: 4, unit_limit: 3 },
      { id: "onslaught", name: "Onslaught", points: 3000, dp: null, enh: null, unit_limit: null, undefined_limits: true }],
    groups: [{ name: "Xenos", factions: [{ id: "fx", name: "Fixture Xenos", data: "fx" }, { id: "fx-sub", name: "Fixture Sub", data: "fx" }] }],
    factions: [{ id: "fx", name: "Fixture Xenos", units: [
      { n: "Hero A", r: "Epic Hero", kw: ["Character", "Epic Hero"], t: [[1, null, [[1, 100]]]] },
      { n: "Captain", r: "Character", kw: ["Character", "Infantry"], t: [[1, null, [[1, 80]]]] },
      { n: "Troops", r: "Battleline", kw: ["Battleline", "Infantry"], t: [[1, 2, [[5, 60], [10, 120]]], [3, null, [[5, 70], [10, 140]]]] },
      { n: "Tank", r: "Vehicle", kw: ["Vehicle"], t: [[1, null, [[1, 150]]]], w: [["Big Gun", 10]] },
      { n: "Walls", r: "Fortification", kw: ["Fortification"], t: [[1, null, [[1, 100], [null, 30, "+ 1 Extra Wall"]]]] },
      { n: "Drone", r: "Infantry", kw: ["Infantry"], t: [[1, null, [[1, 20]]]] },
      { n: "Old Guy", r: "Character", kw: ["Character"], t: [[1, null, [[1, 50]]]], lg: 1 },
      { n: "Squad", r: "Infantry", kw: ["Infantry"], t: [[1, null, [[5, 80], [10, 160]]]], w: [["Power fist", 5]],
        lo: { mn: 5, mx: 10, m: [
          ["Sergeant", 1, 1, ["Bolt pistol"], [["Weapon 1", [["Bolt Rifle", null, null, null, null], ["Plasma pistol", null, null, null, null], ["Power fist", 1, null, 0, null]], ["Bolt Rifle"], 1, null, 0]], null, null, 0],
          ["Trooper", 4, 9, ["Bolt pistol", "Bolt Rifle"], [["Grenades", [["Krak", null, null, null, null], ["Frag", null, null, null, null]], ["Krak"], 1, null, 0]], null, null, 0],
          ["Trooper w/ Launcher", 0, 1, ["Bolt pistol", "Launcher"], [], "Trooper", [[10, 2]], 0]],
          u: [["Rocket Pod", [["Rocket Pod", 1, null, null, null]], [], 0, 1, 1]] } }],
      dets: [
        { n: "Det A", dp: 2, src: "mfm", fd: ["PURGE THE FOE"], enh: [["Relic", 20, "relic text", 0], ["Upgrade X", 10, "", 1]],
          st: [["Big Strat", 1, "Shooting phase", "Det A – Battle Tactic Stratagem", "Your turn", "WHEN: x\nEFFECT: y"]], rule: ["Rule A", "Do things"] },
        { n: "Det B", dp: 1, src: "mfm", fd: ["TAKE AND HOLD"], enh: [["Sword", 15, "", 0]], st: [] },
        { n: "Det C", dp: 3, src: "mfm", fd: ["PURGE THE FOE"], enh: [["Crown", 25, "", 0]], st: [] },
        { n: "Det GS", dp: 1, src: "gs", fd: [], enh: [], st: [] },
        { n: "Unique 1", dp: 1, src: "mfm", fd: [], rs: ["UNIQUE: DYNASTY"], enh: [], st: [] },
        { n: "Unique 2", dp: 1, src: "mfm", fd: [], rs: ["UNIQUE: DYNASTY"], enh: [], st: [] }] }],
  };
  if (over) over(d);
  return d;
}
module.exports = { fixture };
