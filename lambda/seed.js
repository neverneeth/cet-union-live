'use strict';
// Default post list for the 2026 union election. Seats and groups are fixed here;
// candidates are added from the admin page on the day.

const MAIN = [
  ['chair', 'Chairperson', 1],
  ['vice', 'Vice Chairperson', 1],
  ['gensec', 'General Secretary', 1],
  ['mag', 'Magazine Editor', 1],
  ['arts', 'Arts Club Secretary', 1],
  ['uuc', 'University Union Councillors', 2],
  ['women', 'Women Representatives', 2],
];

// [id, programme, years of study]
const UG = [
  ['ug-ce', 'B.Tech Civil Engineering', 4],
  ['ug-me', 'B.Tech Mechanical Engineering', 4],
  ['ug-eee', 'B.Tech Electrical & Electronics Engineering', 4],
  ['ug-ece', 'B.Tech Electronics & Communication Engineering', 4],
  ['ug-cse', 'B.Tech Computer Science & Engineering', 4],
  ['ug-aei', 'B.Tech Applied Electronics & Instrumentation', 4],
  ['ug-ie', 'B.Tech Industrial Engineering', 4],
  ['ug-ecs', 'B.Tech Electrical & Computer Engineering', 4],
  ['ug-arch', 'B.Arch Architecture & Planning', 5],
];

const PG = [
  ['pg-env', 'M.Tech Environmental Engineering'],
  ['pg-geoinfo', 'M.Tech Geoinformatics'],
  ['pg-geotech', 'M.Tech Geotechnical Engineering'],
  ['pg-hydraulics', 'M.Tech Hydraulics Engineering'],
  ['pg-structural', 'M.Tech Structural Engineering'],
  ['pg-traffic', 'M.Tech Traffic and Transportation Engineering'],
  ['pg-thermal', 'M.Tech Thermal Science'],
  ['pg-machine', 'M.Tech Machine Design'],
  ['pg-manufacturing', 'M.Tech Manufacturing & Automation'],
  ['pg-ie', 'M.Tech Industrial Engineering'],
  ['pg-propulsion', 'M.Tech Propulsion Engineering'],
  ['pg-financial', 'M.Tech Financial Engineering'],
  ['pg-renewable', 'M.Tech Renewable Energy'],
  ['pg-elmachines', 'M.Tech Electrical Machines'],
  ['pg-power', 'M.Tech Power Systems'],
  ['pg-control', 'M.Tech Control Systems'],
  ['pg-gnc', 'M.Tech Guidance and Navigation Control'],
  ['pg-pe', 'M.Tech Power Electronics'],
  ['pg-aei', 'M.Tech Applied Electronics & Instrumentation'],
  ['pg-comm', 'M.Tech Communication Systems'],
  ['pg-mne', 'M.Tech Micro & Nano Electronics'],
  ['pg-robotics', 'M.Tech Robotics & Automation'],
  ['pg-sp', 'M.Tech Signal Processing'],
  ['pg-cse', 'M.Tech Computer Science & Engineering'],
  ['pg-infosec', 'M.Tech Information Security'],
  ['pg-ai', 'M.Tech Artificial Intelligence'],
  ['pg-mca', 'MCA Master of Computer Applications'],
  ['pg-mba', 'MBA Master of Business Administration'],
  ['pg-march-env', 'M.Arch Environmental Design'],
  ['pg-march-urban', 'M.Arch Urban Design'],
  ['pg-mplan', 'M.Plan Housing'],
];

function seedPosts() {
  let order = 0;
  const posts = [];
  for (const [id, name, seats] of MAIN) {
    posts.push({ id, name, dept: null, group: 'main', seats, years: null, order: order++, candidates: [], final: false, winners: [], version: 1 });
  }
  for (const [id, dept, years] of UG) {
    posts.push({ id, name: 'UG Representative', dept, group: 'ug', seats: 1, years, order: order++, candidates: [], final: false, winners: [], version: 1 });
  }
  for (const [id, dept] of PG) {
    posts.push({ id, name: 'PG Representative', dept, group: 'pg', seats: 1, years: 2, order: order++, candidates: [], final: false, winners: [], version: 1 });
  }
  return posts;
}

module.exports = { seedPosts };
