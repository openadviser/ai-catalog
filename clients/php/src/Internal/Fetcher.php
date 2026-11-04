<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Internal;

use OpenAdviser\AiCatalog\Exception\SourceException;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Throwable;

/**
 * Fetches bytes over PSR-18, following redirects itself so that it can refuse the dangerous ones.
 *
 * - Only `https` is fetched, unless insecure HTTP is explicitly allowed. A redirect from `https` to
 *   `http` is refused under the same rule, for the catalog and for its digest sidecar alike: a
 *   downgrade would put the bytes, or the digest that vouches for them, in the hands of anyone on
 *   the path.
 * - Redirects are limited, and a relative `Location` is resolved against the URL it came from.
 * - Any failure, in sending the request, in the response, or in reading its body, is a
 *   {@see SourceException} with the original as `previous`. Nothing else escapes.
 *
 * A PSR-18 client may follow redirects before this code sees them. Configure it not to, or its
 * redirects are outside this check.
 *
 * @internal
 */
final class Fetcher
{
    private const int MAX_REDIRECTS = 5;

    private const array REDIRECTS = [301, 302, 303, 307, 308];

    private function __construct() {}

    /**
     * @throws SourceException
     */
    public static function get(ClientInterface $client, RequestFactoryInterface $requests, string $url, bool $allowInsecureHttp): string
    {
        $current = $url;
        for ($hops = 0;; ++$hops) {
            self::checkScheme($current, $url, $allowInsecureHttp);
            try {
                $response = $client->sendRequest($requests->createRequest('GET', $current));
                $status = $response->getStatusCode();
                if (in_array($status, self::REDIRECTS, true)) {
                    $location = trim($response->getHeaderLine('Location'));
                    $body = null;
                } else {
                    $location = null;
                    $body = $status === 200 ? (string) $response->getBody() : null;
                }
            } catch (SourceException $e) {
                throw $e;
            } catch (Throwable $e) {
                throw new SourceException('cannot fetch ' . $current . ': ' . $e->getMessage(), 0, $e);
            }

            if ($location === null) {
                if ($body === null) {
                    throw new SourceException('fetching ' . $current . ' returned HTTP ' . $status);
                }

                return $body;
            }
            if ($location === '') {
                throw new SourceException('fetching ' . $current . ' returned a redirect without a Location');
            }
            if ($hops >= self::MAX_REDIRECTS) {
                throw new SourceException('fetching ' . $url . ' was redirected more than ' . self::MAX_REDIRECTS . ' times');
            }
            $current = Url::resolve($current, $location);
        }
    }

    private static function checkScheme(string $url, string $origin, bool $allowInsecureHttp): void
    {
        $scheme = Url::scheme($url);
        if ($scheme === 'https' || ($scheme === 'http' && $allowInsecureHttp)) {
            return;
        }
        if ($scheme === 'http') {
            throw new SourceException($url === $origin
                ? 'refusing the insecure URL ' . $url . ': pass allowInsecureHttp to fetch over http'
                : 'refusing a redirect from ' . $origin . ' to the insecure URL ' . $url . ': pass allowInsecureHttp to follow it');
        }

        throw new SourceException('refusing ' . $url . ': only https URLs are fetched');
    }
}
