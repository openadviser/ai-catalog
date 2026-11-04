<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

/**
 * Just enough of RFC 3986 to follow a redirect and to name the digest sidecar of a catalog URL. No
 * host is resolved, normalised or validated here; the caller's HTTP client does that.
 *
 * @internal
 */
final class Url
{
    private const string PARTS = '~^(?:([^:/?#]+):)?(?://([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$~s';

    private function __construct() {}

    /** The lowercase scheme of an absolute URL, or null when it has none. */
    public static function scheme(string $url): ?string
    {
        $parts = self::split($url);

        return $parts['scheme'] === null ? null : strtolower($parts['scheme']);
    }

    /**
     * The URL of a catalog's digest sidecar: `.sha256` appended to the path, the query kept, the
     * fragment dropped. `https://h/d/catalog.json?v=2#x` becomes `https://h/d/catalog.json.sha256?v=2`.
     */
    public static function sidecar(string $url): string
    {
        $parts = self::split($url);
        $path = $parts['path'];
        if ($parts['authority'] !== null && ($path === '' || $path === '/')) {
            $path = '/';
        }

        return self::join($parts['scheme'], $parts['authority'], $path . '.sha256', $parts['query']);
    }

    /** RFC 3986 section 5.2: a `Location` reference resolved against the URL it came from. */
    public static function resolve(string $base, string $reference): string
    {
        $b = self::split($base);
        $r = self::split($reference);

        if ($r['scheme'] !== null) {
            return self::join($r['scheme'], $r['authority'], self::removeDotSegments($r['path']), $r['query']);
        }
        if ($r['authority'] !== null) {
            return self::join($b['scheme'], $r['authority'], self::removeDotSegments($r['path']), $r['query']);
        }
        if ($r['path'] === '') {
            return self::join($b['scheme'], $b['authority'], $b['path'], $r['query'] ?? $b['query']);
        }
        if (str_starts_with($r['path'], '/')) {
            $path = self::removeDotSegments($r['path']);
        } else {
            $lastSlash = strrpos($b['path'], '/');
            $merged = $b['authority'] !== null && $b['path'] === ''
                ? '/' . $r['path']
                : ($lastSlash === false ? '' : substr($b['path'], 0, $lastSlash + 1)) . $r['path'];
            $path = self::removeDotSegments($merged);
        }

        return self::join($b['scheme'], $b['authority'], $path, $r['query']);
    }

    /**
     * RFC 3986 appendix B. A part that is absent is null; one that is present and empty is "".
     *
     * @return array{scheme: ?string, authority: ?string, path: string, query: ?string, fragment: ?string}
     */
    private static function split(string $url): array
    {
        preg_match(self::PARTS, $url, $m, PREG_UNMATCHED_AS_NULL);

        return [
            'scheme' => $m[1] ?? null,
            'authority' => $m[2] ?? null,
            'path' => $m[3] ?? '',
            'query' => $m[4] ?? null,
            'fragment' => $m[5] ?? null,
        ];
    }

    private static function join(?string $scheme, ?string $authority, string $path, ?string $query): string
    {
        return ($scheme === null ? '' : $scheme . ':')
            . ($authority === null ? '' : '//' . $authority)
            . $path
            . ($query === null ? '' : '?' . $query);
    }

    /** RFC 3986 section 5.2.4. */
    private static function removeDotSegments(string $path): string
    {
        $output = [];
        $segments = explode('/', $path);
        $last = count($segments) - 1;
        foreach ($segments as $i => $segment) {
            if ($segment === '.') {
                if ($i === $last) {
                    $output[] = '';
                }
            } elseif ($segment === '..') {
                if (count($output) > 1) {
                    array_pop($output);
                }
                if ($i === $last) {
                    $output[] = '';
                }
            } else {
                $output[] = $segment;
            }
        }

        return implode('/', $output);
    }
}
