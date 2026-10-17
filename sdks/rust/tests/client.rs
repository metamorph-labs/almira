use metamorph_almira::{
    ApiError, CONTRACT_VERSION, Client, ClientError, ClientOptions, CollectionReference,
    CustomMetadataValue, DerivativeReference, Error, FileReference, ImmutableGenerationReference,
    ListFilesOptions, ReadOptions, SearchInput,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver};
use std::thread;

const TENANT: &str = "018f0000-0000-7000-8000-000000000002";
const PROJECT: &str = "018f0000-0000-7000-8000-000000000003";
const ENVIRONMENT: &str = "018f0000-0000-7000-8000-000000000004";
const COLLECTION: &str = "018f0000-0000-7000-8000-000000000005";
const ENTRY: &str = "018f0000-0000-7000-8000-000000000006";
const GENERATION: &str = "018f0000-0000-7000-8000-000000000007";
const REQUEST: &str = "018f0000-0000-7000-8000-000000000008";
const CAPABILITY: &str = "alm_cap_v1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[derive(Debug)]
struct Request {
    method: String,
    target: String,
    headers: BTreeMap<String, String>,
    body: String,
}

struct Response {
    status: &'static str,
    content_type: &'static str,
    headers: Vec<(&'static str, &'static str)>,
    body: String,
}

#[test]
fn methods_and_version_cover_promoted_contract_exactly() {
    let contract: Value =
        serde_json::from_str(include_str!("../../../contracts/data-openapi.v1.json"))
            .expect("contract parses");
    let mut operations = contract["paths"]
        .as_object()
        .unwrap()
        .values()
        .flat_map(|path| path.as_object().unwrap().values())
        .filter_map(|operation| operation["operationId"].as_str())
        .map(camel_to_snake)
        .collect::<Vec<_>>();
    let mut methods = include_str!("../src/client.rs")
        .lines()
        .filter_map(|line| line.trim().strip_prefix("pub async fn "))
        .filter_map(|line| line.split('(').next())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    operations.sort();
    methods.sort();
    assert_eq!(CONTRACT_VERSION, contract["info"]["version"]);
    assert_eq!(methods, operations);
}

#[tokio::test]
async fn exact_routes_filters_streaming_and_credential_free_share() {
    let (base_url, requests) = serve(
        7,
        Arc::new(|request| {
            if request.target.contains("/delivery/") || request.target.contains("/shares/") {
                return Response {
                    status: "206 Partial Content",
                    content_type: "text/plain",
                    headers: vec![("ETag", "\"v1\"")],
                    body: "hello".into(),
                };
            }
            let body = if request.target.ends_with("/search") {
                r#"{"items":[],"facets":[],"next_cursor":null,"facet_coverage":"returned_page","consistency":"eventual_projection_authoritative_recheck"}"#.into()
            } else if request.target.ends_with("/derivatives") {
                "[]".into()
            } else if request.target.ends_with(&format!("/files/{ENTRY}")) {
                file_entry()
            } else {
                r#"{"entries":[],"next_cursor":null}"#.into()
            };
            Response {
                status: "200 OK",
                content_type: "application/json",
                headers: vec![],
                body,
            }
        }),
    );
    let client = Client::new(
        ClientOptions::new(&base_url)
            .capability(CAPABILITY)
            .origin("https://app.example"),
    )
    .unwrap();
    let collection = collection();
    let file = FileReference {
        collection: collection.clone(),
        entry_id: ENTRY.into(),
    };
    let generation = ImmutableGenerationReference {
        file: file.clone(),
        generation_id: GENERATION.into(),
    };

    client
        .list_files_with_capability(
            &collection,
            &ListFilesOptions {
                limit: Some(25),
                cursor: Some("next page".into()),
                path_prefix: Some("avatars".into()),
                tag: Some("profile.photo".into()),
                metadata_key: Some("account.tier".into()),
                metadata_value: Some(CustomMetadataValue::String("pro".into())),
                verified_media_type: Some("image/jpeg".into()),
                minimum_size_bytes: Some(10),
                maximum_size_bytes: Some(5000),
                created_after: Some("2026-01-01T00:00:00Z".into()),
                created_before: Some("2026-02-01T00:00:00Z".into()),
                extraction_kind: Some("technical".into()),
                extraction_state: Some("succeeded".into()),
            },
        )
        .await
        .unwrap();
    client
        .get_file_metadata_with_capability(&file)
        .await
        .unwrap();
    client
        .search_files_with_capability(
            &collection,
            &SearchInput {
                query: "portrait photograph".into(),
                mode: Some("hybrid".into()),
                path_prefix: None,
                filter: None,
                facets: None,
                page_size: None,
                cursor: None,
            },
        )
        .await
        .unwrap();
    client
        .list_derivatives_with_capability(&generation)
        .await
        .unwrap();
    let mut stream = client
        .read_immutable_generation(
            &generation,
            &ReadOptions {
                range: Some("bytes=0-4".into()),
                if_none_match: Some("\"old\"".into()),
            },
        )
        .await
        .unwrap();
    assert_eq!(stream.status, 206);
    assert_eq!(stream.content_length, Some(5));
    assert_eq!(stream.chunk().await.unwrap().unwrap(), b"hello");
    assert!(stream.chunk().await.unwrap().is_none());
    let derivative = DerivativeReference {
        generation: generation.clone(),
        variant_key: "hls/720p/segment-1.m4s".into(),
    };
    client
        .read_derivative(&derivative, &ReadOptions::default())
        .await
        .unwrap();
    client
        .read_share(
            &format!("alm_share_v1.{}", "b".repeat(43)),
            &ReadOptions::default(),
        )
        .await
        .unwrap();

    let calls = (0..7).map(|_| requests.recv().unwrap()).collect::<Vec<_>>();
    let base = format!("/v1/data/{TENANT}/{PROJECT}/{ENVIRONMENT}/{COLLECTION}");
    let list_url = reqwest::Url::parse(&format!("http://test{}", calls[0].target)).unwrap();
    assert_eq!(calls[0].method, "GET");
    assert_eq!(list_url.path(), format!("{base}/files"));
    let query = list_url
        .query_pairs()
        .into_owned()
        .collect::<BTreeMap<_, _>>();
    assert_eq!(
        query.get("metadata_value").map(String::as_str),
        Some("\"pro\"")
    );
    assert_eq!(
        query.get("extraction_state").map(String::as_str),
        Some("succeeded")
    );
    assert_eq!(calls[1].target, format!("{base}/files/{ENTRY}"));
    assert_eq!(calls[2].target, format!("{base}/search"));
    assert_eq!(
        serde_json::from_str::<Value>(&calls[2].body).unwrap()["query"],
        "portrait photograph"
    );
    assert_eq!(
        calls[3].target,
        format!("{base}/files/{ENTRY}/versions/{GENERATION}/derivatives")
    );
    assert_eq!(
        calls[4].headers.get("range").map(String::as_str),
        Some("bytes=0-4")
    );
    assert!(
        calls[5]
            .target
            .ends_with("/variants/hls/720p/segment-1.m4s")
    );
    let bearer = format!("Bearer {CAPABILITY}");
    for call in &calls[..6] {
        assert_eq!(
            call.headers.get("authorization").map(String::as_str),
            Some(bearer.as_str())
        );
        assert_eq!(
            call.headers.get("origin").map(String::as_str),
            Some("https://app.example")
        );
    }
    assert!(!calls[6].headers.contains_key("authorization"));
    assert!(!calls[6].headers.contains_key("origin"));
}

#[tokio::test]
async fn invalid_input_and_provider_failure_are_local_and_stable() {
    let client =
        Client::new(ClientOptions::new("https://almira.test").capability(CAPABILITY)).unwrap();
    let invalid = ListFilesOptions {
        metadata_key: Some("tier".into()),
        ..ListFilesOptions::default()
    };
    assert_client_code(
        client
            .list_files_with_capability(&collection(), &invalid)
            .await
            .unwrap_err(),
        "ALMIRA_CLIENT_INPUT_INVALID",
    );
    let derivative = DerivativeReference {
        generation: generation(),
        variant_key: "../secret".into(),
    };
    let error = match client
        .read_derivative(&derivative, &ReadOptions::default())
        .await
    {
        Err(error) => error,
        Ok(_) => panic!("invalid derivative was accepted"),
    };
    assert_client_code(error, "ALMIRA_CLIENT_INPUT_INVALID");
    assert!(
        Client::new(
            ClientOptions::new("https://almira.test").origin("https://app.example\nforwarded: bad")
        )
        .is_err()
    );

    let provider = Client::new(
        ClientOptions::new("https://almira.test").capability_provider(Arc::new(|| None)),
    )
    .unwrap();
    assert_client_code(
        provider
            .get_file_metadata_with_capability(&generation().file)
            .await
            .unwrap_err(),
        "ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE",
    );
}

#[tokio::test]
async fn api_errors_are_bounded_and_typed() {
    let (base_url, _) = serve(
        1,
        Arc::new(|_| Response {
            status: "403 Forbidden",
            content_type: "application/json",
            headers: vec![("Retry-After", "7")],
            body: format!(r#"{{"code":"ALMIRA_CAPABILITY_REFUSED","request_id":"{REQUEST}"}}"#),
        }),
    );
    let client = Client::new(ClientOptions::new(base_url).capability(CAPABILITY)).unwrap();
    let error = client
        .get_file_metadata_with_capability(&generation().file)
        .await
        .unwrap_err();
    match error {
        Error::Api(ApiError {
            code,
            request_id,
            status: 403,
            retry_after_seconds: Some(7),
        }) => {
            assert_eq!(code, "ALMIRA_CAPABILITY_REFUSED");
            assert_eq!(request_id, REQUEST);
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

fn collection() -> CollectionReference {
    CollectionReference {
        tenant_id: TENANT.into(),
        project_id: PROJECT.into(),
        environment_id: ENVIRONMENT.into(),
        collection_instance_id: COLLECTION.into(),
    }
}

fn generation() -> ImmutableGenerationReference {
    ImmutableGenerationReference {
        file: FileReference {
            collection: collection(),
            entry_id: ENTRY.into(),
        },
        generation_id: GENERATION.into(),
    }
}

fn file_entry() -> String {
    let generation = format!(
        r#"{{"entry_id":"{ENTRY}","generation_id":"{GENERATION}","generation_number":1,"state":"available","expected_size_bytes":5,"content_sha256":"sha256:{}","declared_media_type":"text/plain","malware_scan_requirement":"required","safety_state":"clean","revision":1,"created_at":"2026-01-01T00:00:00Z"}}"#,
        "a".repeat(64)
    );
    format!(
        r#"{{"entry_id":"{ENTRY}","logical_path":"hello.txt","lifecycle":"active","revision":1,"metadata_revision":1,"tags":[],"custom_metadata":{{}},"current_generation_id":"{GENERATION}","current_generation":{generation},"deleted_at":null,"recycle_until":null,"latest_generation":{generation},"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}}"#
    )
}

fn assert_client_code(error: Error, code: &str) {
    assert_eq!(
        error,
        Error::Client(ClientError {
            code: match code {
                "ALMIRA_CLIENT_INPUT_INVALID" => "ALMIRA_CLIENT_INPUT_INVALID",
                "ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE" => "ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE",
                _ => panic!("unexpected test code"),
            }
        })
    );
}

fn camel_to_snake(value: &str) -> String {
    let mut result = String::new();
    for character in value.chars() {
        if character.is_ascii_uppercase() {
            result.push('_');
            result.push(character.to_ascii_lowercase());
        } else {
            result.push(character);
        }
    }
    result
}

fn serve(
    expected: usize,
    responder: Arc<dyn Fn(&Request) -> Response + Send + Sync>,
) -> (String, Receiver<Request>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for _ in 0..expected {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            let response = responder(&request);
            let _ = sender.send(request);
            let mut headers = format!(
                "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n",
                response.status,
                response.content_type,
                response.body.len()
            );
            for (name, value) in response.headers {
                headers.push_str(&format!("{name}: {value}\r\n"));
            }
            write!(stream, "{headers}\r\n{}", response.body).unwrap();
        }
    });
    (format!("http://{address}"), receiver)
}

fn read_request(stream: &mut impl Read) -> Request {
    let mut raw = Vec::new();
    let mut buffer = [0_u8; 1024];
    let header_end = loop {
        let read = stream.read(&mut buffer).unwrap();
        assert!(read > 0);
        raw.extend_from_slice(&buffer[..read]);
        if let Some(index) = raw.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let head = String::from_utf8(raw[..header_end].to_vec()).unwrap();
    let mut lines = head.split("\r\n");
    let mut start = lines.next().unwrap().split_whitespace();
    let method = start.next().unwrap().to_owned();
    let target = start.next().unwrap().to_owned();
    let headers = lines
        .filter_map(|line| line.split_once(": "))
        .map(|(name, value)| (name.to_ascii_lowercase(), value.to_owned()))
        .collect::<BTreeMap<_, _>>();
    let length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    while raw.len() < header_end + length {
        let read = stream.read(&mut buffer).unwrap();
        raw.extend_from_slice(&buffer[..read]);
    }
    Request {
        method,
        target,
        headers,
        body: String::from_utf8(raw[header_end..header_end + length].to_vec()).unwrap(),
    }
}
