using Metamorph.Almira;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton(new AlmiraDataClient(
    Required("ALMIRA_BASE_URL"),
    _ => ValueTask.FromResult(Required("ALMIRA_CAPABILITY")),
    retry: new RetryPolicy(3, TimeSpan.FromMilliseconds(100), TimeSpan.FromSeconds(2))));
var app = builder.Build();

app.MapGet("/files/{entryId}", async (HttpRequest request, string entryId, AlmiraDataClient client) =>
{
    if (string.IsNullOrWhiteSpace(request.Headers["X-App-User"]))
        return Results.Json(new { code = "ALMIRA_EXAMPLE_FORBIDDEN" }, statusCode: 403);
    var entry = await client.GetFileMetadataWithCapability(new FileReference(
        Required("ALMIRA_TENANT_ID"), Required("ALMIRA_PROJECT_ID"),
        Required("ALMIRA_ENVIRONMENT_ID"), Required("ALMIRA_COLLECTION_ID"), entryId));
    return Results.Json(entry);
});

app.Run();

static string Required(string name) => Environment.GetEnvironmentVariable(name) is { Length: > 0 } value
    ? value : throw new InvalidOperationException($"{name} is required");
