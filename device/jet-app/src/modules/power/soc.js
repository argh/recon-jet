// State of charge from voltage: compensate the terminal voltage for the current through the
// cell's internal resistance (positive current = charging raises the reading, discharging lowers
// it), then map the estimated open-circuit voltage through a Li-ion curve instead of a line.
// Coulomb counting from the PMIC accumulator would be the next step; this removes the step when
// the charger is unplugged and makes the bar roughly linear in energy.

/** OCV (mV) -> percent, typical single-cell Li-ion, rest. */
const CURVE = [[3300, 0], [3450, 3], [3550, 10], [3620, 20], [3680, 35], [3740, 50], [3800, 60], [3870, 70], [3950, 80], [4030, 90], [4100, 96], [4180, 100]];

/** @param {number} vbat mV  @param {number} ma signed mA (+ = charging)  @param {number} ohms cell + path resistance */
export function openCircuitVoltage(vbat, ma, ohms) { return vbat - ma * ohms; }

/** @param {number} ocv mV  @returns {number} 0..100 */
export function percentFromOcv(ocv) {
  if (ocv <= CURVE[0][0]) return 0;
  for (let i = 1; i < CURVE.length; i++) {
    const [v0, p0] = CURVE[i - 1], [v1, p1] = CURVE[i];
    if (ocv <= v1) return Math.round(p0 + (p1 - p0) * (ocv - v0) / (v1 - v0));
  }
  return 100;
}

/**
 * @param {{vbat:number, ma:number, vbus:number}} m smoothed reading
 * @param {{ohms:number, termMa:number}} opts
 * @returns {{percent:number, ocv:number, full:boolean, charging:boolean}}
 */
export function stateOfCharge(m, { ohms = 0.25, termMa = 40 } = {}) {
  const charging = m.vbus > 4300 && m.ma > 0;
  const ocv = Math.round(openCircuitVoltage(m.vbat, m.ma, ohms));
  const full = m.vbus > 4300 && m.ma >= 0 && m.ma < termMa && m.vbat >= 4100;   // charger tapered off near the top
  return { percent: full ? 100 : percentFromOcv(ocv), ocv, full, charging };
}
