// server/shared/time.js
// أدوات الوقت الخاصة بنظام الدوام — نافذة الدوام المسموحة: 22:00 - 04:00 بتوقيت الجزائر
// الجزائر = UTC+1 طول السنة (بلا توقيت صيفي)

const ALGERIA_OFFSET_MS = 60 * 60 * 1000; // +1 ساعة
const DUTY_START_HOUR = 22; // 22:00
const DUTY_END_HOUR = 4;    // 04:00
const DUTY_WINDOW_MS = 6 * 60 * 60 * 1000; // من 22:00 حتى 04:00 = 6 سوايع

function algeriaNow() {
    return new Date(Date.now() + ALGERIA_OFFSET_MS);
}

function isInDutyTimeWindow() {
    const hour = algeriaNow().getUTCHours();
    return hour >= DUTY_START_HOUR || hour < DUTY_END_HOUR;
}

function getDutyDayWindow(offset = 0) {
    const dzNow = algeriaNow();
    const startUtcMs = Date.UTC(
        dzNow.getUTCFullYear(),
        dzNow.getUTCMonth(),
        dzNow.getUTCDate() + offset,
        DUTY_START_HOUR, 0, 0, 0
    ) - ALGERIA_OFFSET_MS;

    return {
        start: new Date(startUtcMs),
        end: new Date(startUtcMs + DUTY_WINDOW_MS)
    };
}

function buildDutyWeekDays(count = 7) {
    const days = [];
    for (let i = count; i >= 1; i--) {
        const { start, end } = getDutyDayWindow(-i);
        const label = new Date(start.getTime() + ALGERIA_OFFSET_MS).toISOString().slice(0, 10);
        days.push({ start, end, label });
    }
    return days;
}

module.exports = { isInDutyTimeWindow, algeriaNow, getDutyDayWindow, buildDutyWeekDays };
