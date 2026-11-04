<?php

declare(strict_types=1);

namespace OpenAdviser\AiCatalog\Tests;

use OpenAdviser\AiCatalog\Catalog;
use OpenAdviser\AiCatalog\CatalogLoader;
use OpenAdviser\AiCatalog\Exception\LoadException;
use OpenAdviser\AiCatalog\Exception\SourceException;
use OpenAdviser\AiCatalog\Internal\Fetcher;
use OpenAdviser\AiCatalog\Internal\Url;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\StreamInterface;
use Psr\Http\Message\UriInterface;
use RuntimeException;
use Throwable;

/**
 * The URL loader: what it asks for, what it refuses to follow, and what an unreadable response
 * becomes. A scripted client answers by URL and records every URL it was asked for.
 */
#[CoversClass(Catalog::class)]
#[CoversClass(CatalogLoader::class)]
#[CoversClass(Fetcher::class)]
#[CoversClass(Url::class)]
final class CatalogUrlTest extends TestCase
{
    private const string CATALOG_URL = 'https://example.com/data/catalog.json';

    /** @var list<string> */
    private array $asked = [];

    /**
     * @param array<string, array{int, string, array<string, string>}|Throwable> $routes URL => [status, body, headers] or an exception to throw
     */
    private function client(array $routes): ClientInterface
    {
        $this->asked = [];
        $client = self::createStub(ClientInterface::class);
        $client->method('sendRequest')->willReturnCallback(function (RequestInterface $request) use ($routes): ResponseInterface {
            $url = (string) $request->getUri();
            $this->asked[] = $url;
            $route = $routes[$url] ?? [404, 'not found', []];
            if ($route instanceof Throwable) {
                throw $route;
            }
            [$status, $body, $headers] = $route;
            $stream = self::createStub(StreamInterface::class);
            $stream->method('__toString')->willReturn($body);
            $response = self::createStub(ResponseInterface::class);
            $response->method('getStatusCode')->willReturn($status);
            $response->method('getHeaderLine')->willReturnCallback(static fn(string $name): string => $headers[$name] ?? '');
            $response->method('getBody')->willReturn($stream);

            return $response;
        });

        return $client;
    }

    private function requests(): RequestFactoryInterface
    {
        $factory = self::createStub(RequestFactoryInterface::class);
        $factory->method('createRequest')->willReturnCallback(static function (string $method, string|UriInterface $uri): RequestInterface {
            $u = self::createStub(UriInterface::class);
            $u->method('__toString')->willReturn((string) $uri);
            $request = self::createStub(RequestInterface::class);
            $request->method('getUri')->willReturn($u);

            return $request;
        });

        return $factory;
    }

    private static function catalog(): string
    {
        return CatalogFactory::json([CatalogFactory::rate('input', '1')]);
    }

    // ---------------------------------------------------------------- the digest sidecar

    /**
     * @return iterable<string, array{string, string}>
     */
    public static function sidecars(): iterable
    {
        yield 'a plain path' => ['https://example.com/data/catalog.json', 'https://example.com/data/catalog.json.sha256'];
        yield 'the query is kept' => ['https://example.com/data/catalog.json?v=2&x=y', 'https://example.com/data/catalog.json.sha256?v=2&x=y'];
        yield 'the fragment is dropped' => ['https://example.com/data/catalog.json#top', 'https://example.com/data/catalog.json.sha256'];
        yield 'query kept and fragment dropped' => ['https://example.com/data/catalog.json?v=2#top', 'https://example.com/data/catalog.json.sha256?v=2'];
        yield 'an empty query is kept' => ['https://example.com/catalog.json?', 'https://example.com/catalog.json.sha256?'];
        yield 'a port and credentials-free authority' => ['https://example.com:8443/c.json', 'https://example.com:8443/c.json.sha256'];
        yield 'the suffix goes on the path, not after the query' => ['https://example.com/c.json?file=a.json', 'https://example.com/c.json.sha256?file=a.json'];
        yield 'no path' => ['https://example.com', 'https://example.com/.sha256'];
        yield 'a trailing slash' => ['https://example.com/data/', 'https://example.com/data/.sha256'];
    }

    #[DataProvider('sidecars')]
    public function testTheSidecarUrlAppendsToThePathKeepsTheQueryAndDropsTheFragment(string $catalog, string $sidecar): void
    {
        self::assertSame($sidecar, Url::sidecar($catalog));
    }

    public function testWithoutADigestTheLoaderFetchesTheSidecarAndChecksTheBytesAgainstIt(): void
    {
        $bytes = self::catalog();
        $digest = hash('sha256', $bytes);
        $client = $this->client([
            'https://example.com/data/catalog.json?v=2#top' => [200, $bytes, []],
            'https://example.com/data/catalog.json.sha256?v=2' => [200, $digest . "  catalog.json\n", []],
        ]);

        $catalog = Catalog::loadUrl($client, $this->requests(), 'https://example.com/data/catalog.json?v=2#top');

        self::assertSame($digest, $catalog->sha256);
        self::assertSame(['https://example.com/data/catalog.json?v=2#top', 'https://example.com/data/catalog.json.sha256?v=2'], $this->asked);
    }

    public function testASidecarThatDoesNotMatchTheBytesRejectsTheCatalog(): void
    {
        $client = $this->client([
            self::CATALOG_URL => [200, self::catalog(), []],
            self::CATALOG_URL . '.sha256' => [200, str_repeat('0', 64) . "  catalog.json\n", []],
        ]);
        try {
            Catalog::loadUrl($client, $this->requests(), self::CATALOG_URL);
            self::fail('loaded');
        } catch (LoadException $e) {
            self::assertSame('hash-mismatch', $e->errorCode());
        }
    }

    public function testAMissingSidecarIsASourceFailureAndAGivenDigestSkipsIt(): void
    {
        $bytes = self::catalog();
        $client = $this->client([self::CATALOG_URL => [200, $bytes, []]]);
        try {
            Catalog::loadUrl($client, $this->requests(), self::CATALOG_URL);
            self::fail('loaded');
        } catch (SourceException $e) {
            self::assertStringContainsString('HTTP 404', $e->getMessage());
        }

        $client = $this->client([self::CATALOG_URL => [200, $bytes, []]]);
        Catalog::loadUrl($client, $this->requests(), self::CATALOG_URL, hash('sha256', $bytes));
        self::assertSame([self::CATALOG_URL], $this->asked, 'a given digest means no second request');
    }

    // ---------------------------------------------------------------- redirects

    public function testARedirectFromHttpsToHttpIsNotFollowed(): void
    {
        $client = $this->client([
            self::CATALOG_URL => [302, '', ['Location' => 'http://example.com/data/catalog.json']],
            'http://example.com/data/catalog.json' => [200, self::catalog(), []],
        ]);
        try {
            Catalog::loadUrl($client, $this->requests(), self::CATALOG_URL, str_repeat('0', 64));
            self::fail('followed a downgrade');
        } catch (SourceException $e) {
            self::assertStringContainsString('insecure', $e->getMessage());
        }
        self::assertSame([self::CATALOG_URL], $this->asked, 'the http URL was never requested');
    }

    public function testARedirectOfTheSidecarFromHttpsToHttpIsNotFollowedEither(): void
    {
        $bytes = self::catalog();
        $client = $this->client([
            self::CATALOG_URL => [200, $bytes, []],
            self::CATALOG_URL . '.sha256' => [301, '', ['Location' => 'http://example.com/data/catalog.json.sha256']],
            'http://example.com/data/catalog.json.sha256' => [200, hash('sha256', $bytes), []],
        ]);
        try {
            Catalog::loadUrl($client, $this->requests(), self::CATALOG_URL);
            self::fail('followed a downgrade');
        } catch (SourceException $e) {
            self::assertStringContainsString('insecure', $e->getMessage());
        }
        self::assertSame([self::CATALOG_URL, self::CATALOG_URL . '.sha256'], $this->asked);
    }

    public function testInsecureHttpIsFollowedOnlyWhenExplicitlyAllowed(): void
    {
        $bytes = self::catalog();
        $routes = [
            self::CATALOG_URL => [307, '', ['Location' => 'http://example.com/data/catalog.json']],
            'http://example.com/data/catalog.json' => [200, $bytes, []],
            'http://example.com/data/catalog.json.sha256' => [200, hash('sha256', $bytes), []],
            self::CATALOG_URL . '.sha256' => [308, '', ['Location' => 'http://example.com/data/catalog.json.sha256']],
        ];
        $catalog = Catalog::loadUrl($this->client($routes), $this->requests(), self::CATALOG_URL, allowInsecureHttp: true);
        self::assertSame(hash('sha256', $bytes), $catalog->sha256);

        // The same switch lets the loader start from an http URL, and nothing else does.
        $this->client($routes);
        $this->expectException(SourceException::class);
        $this->expectExceptionMessage('allowInsecureHttp');
        Catalog::loadUrl($this->client($routes), $this->requests(), 'http://example.com/data/catalog.json', str_repeat('0', 64));
    }

    public function testRedirectsWithinHttpsAreFollowedAndRelativeLocationsAreResolved(): void
    {
        $bytes = self::catalog();
        $client = $this->client([
            self::CATALOG_URL => [301, '', ['Location' => '/v2/catalog.json']],
            'https://example.com/v2/catalog.json' => [302, '', ['Location' => 'latest.json?x=1']],
            'https://example.com/v2/latest.json?x=1' => [303, '', ['Location' => '//cdn.example.net/c.json']],
            'https://cdn.example.net/c.json' => [200, $bytes, []],
        ]);
        $catalog = Catalog::loadUrl($client, $this->requests(), self::CATALOG_URL, hash('sha256', $bytes));
        self::assertSame(hash('sha256', $bytes), $catalog->sha256);
        self::assertCount(4, $this->asked);
    }

    public function testRedirectLoopsAndEmptyLocationsAreSourceFailures(): void
    {
        $loop = $this->client([self::CATALOG_URL => [302, '', ['Location' => self::CATALOG_URL]]]);
        try {
            Catalog::loadUrl($loop, $this->requests(), self::CATALOG_URL, str_repeat('0', 64));
            self::fail('looped');
        } catch (SourceException $e) {
            self::assertStringContainsString('more than 5 times', $e->getMessage());
        }
        self::assertCount(6, $this->asked);

        $this->expectException(SourceException::class);
        $this->expectExceptionMessage('without a Location');
        Catalog::loadUrl($this->client([self::CATALOG_URL => [302, '', []]]), $this->requests(), self::CATALOG_URL, str_repeat('0', 64));
    }

    public function testOtherSchemesAreRefused(): void
    {
        foreach (['ftp://example.com/c.json', 'file:///etc/passwd', '//example.com/c.json', 'catalog.json', ''] as $url) {
            try {
                Catalog::loadUrl($this->client([]), $this->requests(), $url, str_repeat('0', 64), allowInsecureHttp: true);
                self::fail('fetched ' . $url);
            } catch (SourceException $e) {
                self::assertStringContainsString('only https', $e->getMessage(), $url);
            }
            self::assertSame([], $this->asked);
        }
    }

    // ---------------------------------------------------------------- failures while fetching or reading

    public function testAFailureReadingTheBodyIsASourceExceptionWithTheOriginalAsPrevious(): void
    {
        $original = new RuntimeException('connection reset while reading the body');
        $stream = self::createStub(StreamInterface::class);
        $stream->method('__toString')->willThrowException($original);
        $response = self::createStub(ResponseInterface::class);
        $response->method('getStatusCode')->willReturn(200);
        $response->method('getBody')->willReturn($stream);
        $client = self::createStub(ClientInterface::class);
        $client->method('sendRequest')->willReturn($response);

        try {
            Catalog::loadUrl($client, $this->requests(), self::CATALOG_URL, str_repeat('0', 64));
            self::fail('loaded');
        } catch (SourceException $e) {
            self::assertSame($original, $e->getPrevious());
            self::assertStringContainsString('connection reset', $e->getMessage());
        }
    }

    public function testAFailureReadingTheSidecarBodyIsASourceExceptionToo(): void
    {
        $original = new RuntimeException('stream is closed');
        $broken = self::createStub(StreamInterface::class);
        $broken->method('__toString')->willThrowException($original);
        $good = self::createStub(StreamInterface::class);
        $good->method('__toString')->willReturn(self::catalog());
        $first = self::createStub(ResponseInterface::class);
        $first->method('getStatusCode')->willReturn(200);
        $first->method('getBody')->willReturn($good);
        $second = self::createStub(ResponseInterface::class);
        $second->method('getStatusCode')->willReturn(200);
        $second->method('getBody')->willReturn($broken);
        $client = self::createStub(ClientInterface::class);
        $client->method('sendRequest')->willReturnOnConsecutiveCalls($first, $second);

        try {
            Catalog::loadUrl($client, $this->requests(), self::CATALOG_URL);
            self::fail('loaded');
        } catch (SourceException $e) {
            self::assertSame($original, $e->getPrevious());
        }
    }

    /**
     * @return iterable<string, array{Throwable}>
     */
    public static function failures(): iterable
    {
        yield 'a runtime exception' => [new RuntimeException('boom')];
        yield 'an error' => [new \Error('not an exception')];
        yield 'a type error' => [new \TypeError('wrong type')];
        yield 'a PSR-18 network exception' => [new class ('down') extends RuntimeException implements \Psr\Http\Client\NetworkExceptionInterface {
            public function getRequest(): RequestInterface
            {
                throw new \LogicException('unused');
            }
        }];
    }

    #[DataProvider('failures')]
    public function testNothingButASourceExceptionEscapesAFailedFetch(Throwable $failure): void
    {
        try {
            Catalog::loadUrl($this->client([self::CATALOG_URL => $failure]), $this->requests(), self::CATALOG_URL, str_repeat('0', 64));
            self::fail('loaded');
        } catch (SourceException $e) {
            self::assertSame($failure, $e->getPrevious());
        }
    }

    public function testAFailureBuildingTheRequestIsASourceException(): void
    {
        $original = new \InvalidArgumentException('bad URI');
        $factory = self::createStub(RequestFactoryInterface::class);
        $factory->method('createRequest')->willThrowException($original);
        try {
            Catalog::loadUrl(self::createStub(ClientInterface::class), $factory, self::CATALOG_URL, str_repeat('0', 64));
            self::fail('loaded');
        } catch (SourceException $e) {
            self::assertSame($original, $e->getPrevious());
        }
    }

    public function testTheLoaderAdoptsACatalogFetchedByUrl(): void
    {
        $bytes = self::catalog();
        $client = $this->client([self::CATALOG_URL => [200, $bytes, []], self::CATALOG_URL . '.sha256' => [200, hash('sha256', $bytes), []]]);
        $loader = new CatalogLoader();
        self::assertSame($loader->loadUrl($client, $this->requests(), self::CATALOG_URL), $loader->lastGood());
    }

    // ---------------------------------------------------------------- RFC 3986 references

    /**
     * RFC 3986 section 5.4.1, the normal examples, against the base `http://a/b/c/d;p?q`.
     *
     * @return iterable<string, array{string, string}>
     */
    public static function references(): iterable
    {
        yield 'g:h' => ['g:h', 'g:h'];
        yield 'g' => ['g', 'http://a/b/c/g'];
        yield './g' => ['./g', 'http://a/b/c/g'];
        yield 'g/' => ['g/', 'http://a/b/c/g/'];
        yield '/g' => ['/g', 'http://a/g'];
        yield '//g' => ['//g', 'http://g'];
        yield '?y' => ['?y', 'http://a/b/c/d;p?y'];
        yield 'g?y' => ['g?y', 'http://a/b/c/g?y'];
        yield 'empty' => ['', 'http://a/b/c/d;p?q'];
        yield '.' => ['.', 'http://a/b/c/'];
        yield './' => ['./', 'http://a/b/c/'];
        yield '..' => ['..', 'http://a/b/'];
        yield '../' => ['../', 'http://a/b/'];
        yield '../g' => ['../g', 'http://a/b/g'];
        yield '../..' => ['../..', 'http://a/'];
        yield '../../g' => ['../../g', 'http://a/g'];
        yield 'beyond the root' => ['../../../g', 'http://a/g'];
        yield 'dot segments inside' => ['g/./h/../i', 'http://a/b/c/g/i'];
        yield 'the fragment of a reference is dropped' => ['g#s', 'http://a/b/c/g'];
    }

    #[DataProvider('references')]
    public function testResolvesReferencesAsRfc3986Does(string $reference, string $expected): void
    {
        self::assertSame($expected, Url::resolve('http://a/b/c/d;p?q', $reference));
    }
}
