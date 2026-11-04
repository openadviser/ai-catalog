<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

/**
 * RFC 3339 UTC instants and calendar dates of TIME-1, checked field by field because a pattern alone
 * cannot express the calendar. No DateTime is involved: instants become integer milliseconds since
 * the epoch by the days-from-civil algorithm, so the host's time zone and locale cannot matter.
 *
 * @internal
 */
final class Instant
{
    private function __construct() {}

    /**
     * An instant of whole seconds, or with one to three fractional digits when `$fraction` is true.
     *
     * @return int|null milliseconds since 1970-01-01T00:00:00Z, or null when the text is not a valid instant
     */
    public static function parse(string $text, bool $fraction = false): ?int
    {
        $pattern = $fraction
            ? '/\A([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?Z\z/'
            : '/\A([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})()Z\z/';
        if (preg_match($pattern, $text, $m) !== 1) {
            return null;
        }
        [$year, $month, $day, $hour, $minute, $second] = array_map(intval(...), array_slice($m, 1, 6));
        if ($year < 1970 || !self::validDay($year, $month, $day)) {
            return null;
        }
        if ($hour > 23 || $minute > 59 || $second > 59) {
            return null;
        }
        $millis = (int) str_pad($m[7] ?? '', 3, '0');
        $days = self::daysFromCivil($year, $month, $day);

        return (($days * 24 + $hour) * 60 + $minute) * 60_000 + $second * 1000 + $millis;
    }

    /** A `YYYY-MM-DD` date, year 1970 to 9999, that exists in the Gregorian calendar. */
    public static function isDate(string $text): bool
    {
        if (preg_match('/\A([0-9]{4})-([0-9]{2})-([0-9]{2})\z/', $text, $m) !== 1) {
            return false;
        }

        return (int) $m[1] >= 1970 && self::validDay((int) $m[1], (int) $m[2], (int) $m[3]);
    }

    /** Whether year, month and day name a real Gregorian date (any year, including 0). */
    public static function validDay(int $year, int $month, int $day): bool
    {
        if ($month < 1 || $month > 12 || $day < 1) {
            return false;
        }
        $leap = ($year % 4 === 0 && $year % 100 !== 0) || $year % 400 === 0;
        $lengths = [31, $leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

        return $day <= $lengths[$month - 1];
    }

    private static function daysFromCivil(int $year, int $month, int $day): int
    {
        $y = $month <= 2 ? $year - 1 : $year;
        $era = intdiv($y, 400);
        $yoe = $y - $era * 400;
        $doy = intdiv(153 * ($month + ($month > 2 ? -3 : 9)) + 2, 5) + $day - 1;
        $doe = $yoe * 365 + intdiv($yoe, 4) - intdiv($yoe, 100) + $doy;

        return $era * 146097 + $doe - 719468;
    }
}
