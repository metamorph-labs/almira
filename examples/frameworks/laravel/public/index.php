<?php

declare(strict_types=1);

use Illuminate\Container\Container;
use Illuminate\Events\Dispatcher;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Routing\Router;
use Metamorph\Almira\AlmiraDataClient;
use Metamorph\Almira\FileReference;
use Metamorph\Almira\RetryPolicy;

require dirname(__DIR__) . '/vendor/autoload.php';

$required = static function (string $name): string {
    $value = getenv($name);
    if ($value === false || $value === '') throw new RuntimeException("$name is required");
    return $value;
};

$container = new Container();
$router = new Router(new Dispatcher($container), $container);
$router->get('/files/{entryId}', function (Request $request, string $entryId) use ($required): JsonResponse {
    if ($request->header('X-App-User') === null) {
        return new JsonResponse(['code' => 'ALMIRA_EXAMPLE_FORBIDDEN'], 403);
    }
    $client = new AlmiraDataClient(
        $required('ALMIRA_BASE_URL'),
        fn(): string => $required('ALMIRA_CAPABILITY'),
        retry: new RetryPolicy(3, 0.1, 2),
    );
    $entry = $client->getFileMetadataWithCapability(new FileReference(
        $required('ALMIRA_TENANT_ID'), $required('ALMIRA_PROJECT_ID'),
        $required('ALMIRA_ENVIRONMENT_ID'), $required('ALMIRA_COLLECTION_ID'), $entryId,
    ));
    return new JsonResponse($entry);
});

$router->dispatch(Request::capture())->send();
