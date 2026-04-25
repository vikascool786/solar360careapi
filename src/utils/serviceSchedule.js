const FREQUENCY_RULES = {
  "1/Month": { intervalDays: 30, annualLimit: null },
  "2/Month": { intervalDays: 15, annualLimit: null },
  "24/Year": { intervalDays: 15, annualLimit: 24 },
  "14/Year": { intervalDays: 26, annualLimit: 14 },
  "12/Year": { intervalDays: 30, annualLimit: 12 },
  "6/Year": { intervalDays: 60, annualLimit: 6 },
};

const FREQUENCY_ALIASES = {
  Monthly: "1/Month",
};

function parseDateValue(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  return new Date(`${value}T00:00:00`);
}

function addDays(dateValue, days) {
  const date = parseDateValue(dateValue);

  if (!date || Number.isNaN(date.getTime())) {
    throw new Error("Invalid date");
  }

  date.setDate(date.getDate() + days);
  return date;
}

function getFrequencyRule(frequency) {
  const rule = FREQUENCY_RULES[normalizeFrequency(frequency)];

  if (!rule) {
    throw new Error(`Invalid frequency: ${frequency}`);
  }

  return rule;
}

function normalizeFrequency(frequency) {
  if (!frequency) {
    return frequency;
  }

  return FREQUENCY_ALIASES[frequency] || frequency;
}

function calculateNextServiceDate(baseDate, frequency) {
  const rule = getFrequencyRule(frequency);
  return addDays(baseDate, rule.intervalDays);
}

function isPlanLimited(frequency) {
  return getFrequencyRule(frequency).annualLimit !== null;
}

function getAnnualVisitLimit(frequency) {
  return getFrequencyRule(frequency).annualLimit;
}

function getPlanEndDate(startDate, frequency) {
  if (!isPlanLimited(frequency)) {
    return null;
  }

  return addDays(startDate, 365);
}

function canScheduleAnotherVisit({
  frequency,
  startDate,
  totalVisits,
  candidateDate,
}) {
  const annualLimit = getAnnualVisitLimit(frequency);

  if (annualLimit !== null && totalVisits >= annualLimit) {
    return false;
  }

  const planEndDate = getPlanEndDate(startDate, frequency);

  if (planEndDate && candidateDate) {
    return parseDateValue(candidateDate) <= planEndDate;
  }

  return true;
}

module.exports = {
  FREQUENCY_RULES,
  addDays,
  calculateNextServiceDate,
  canScheduleAnotherVisit,
  getAnnualVisitLimit,
  getFrequencyRule,
  getPlanEndDate,
  isPlanLimited,
  normalizeFrequency,
  parseDateValue,
};
