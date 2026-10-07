'use strict';

const BUSINESS_TIME_ZONE = 'Asia/Shanghai';
const DAILY_CHECKIN_CREDITS = 1;

const businessDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function getBusinessDate(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('无效的签到日期');
  }

  const parts = Object.fromEntries(
    businessDateFormatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

module.exports = {
  BUSINESS_TIME_ZONE,
  DAILY_CHECKIN_CREDITS,
  getBusinessDate,
};
