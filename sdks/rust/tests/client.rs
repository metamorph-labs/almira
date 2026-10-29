use metamorph_almira::{
    ApiError, BuilderSubject, CONTRACT_VERSION, CapabilityDataClientOptions, CapabilityResource,
    Client, ClientError, ClientOptions, CollectionReference, CreateCapabilitySessionRequest,
    CreateUploadRequest, CustomMetadataValue, DerivativeReference, DirectUploadDescriptor,
    DirectUploadHeader, DirectUploadPart, DirectUploadPartCompletion, DirectUploadResponse,
    DirectUploadTransport, Error, FileReference, FinalizeUploadRequest,
    ImmutableGenerationReference, ListFilesOptions, ReadAccessOperation, ReadOptions, RetryPolicy,
    SearchInput, ServerClient, ServerClientOptions, SubjectBindingPageOptions,
    SubjectProjectReference, SubjectReference, TransferError, upload_direct_file_with,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Seek, Write};
use std::net::TcpListener;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::Duration;
use time::OffsetDateTime;

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
async fn common_managed_development_positive_refusal_retry_and_cleanup_journey() {
    let common: Value =
        serde_json::from_str(include_str!("../../../conformance/application-sdk.v1.json")).unwrap();
    let journey = &common["managed_development"];
    let response_body = serde_json::to_string(&journey["positive"]["response"]).unwrap();
    let (base_url, requests) = serve(
        1,
        Arc::new(move |_| Response {
            status: "200 OK",
            content_type: "application/json",
            headers: vec![],
            body: response_body.clone(),
        }),
    );
    let reference = FileReference {
        collection: CollectionReference {
            tenant_id: journey["reference"]["tenant_id"].as_str().unwrap().into(),
            project_id: journey["reference"]["project_id"].as_str().unwrap().into(),
            environment_id: journey["reference"]["environment_id"]
                .as_str()
                .unwrap()
                .into(),
            collection_instance_id: journey["reference"]["collection_instance_id"]
                .as_str()
                .unwrap()
                .into(),
        },
        entry_id: journey["reference"]["entry_id"].as_str().unwrap().into(),
    };
    let positive = Client::new(
        ClientOptions::new(&base_url)
            .capability(journey["positive"]["capability"].as_str().unwrap())
            .origin(journey["origin"].as_str().unwrap()),
    )
    .unwrap();
    let entry = positive
        .get_file_metadata_with_capability(&reference)
        .await
        .unwrap();
    assert_eq!(entry.entry_id, reference.entry_id);
    assert_eq!(
        requests.recv().unwrap().headers["authorization"],
        format!(
            "Bearer {}",
            journey["positive"]["capability"].as_str().unwrap()
        ),
    );

    let refused = Client::new(
        ClientOptions::new(journey["base_url"].as_str().unwrap())
            .capability(journey["refusal"]["credential"].as_str().unwrap()),
    )
    .unwrap();
    assert_client_code(
        refused
            .get_file_metadata_with_capability(&reference)
            .await
            .unwrap_err(),
        journey["refusal"]["client_code"].as_str().unwrap(),
    );

    let server_attempt = Arc::new(AtomicUsize::new(0));
    let server_counter = Arc::clone(&server_attempt);
    let retry_body = serde_json::to_string(&journey["retry"]["first_error"]).unwrap();
    let final_body = serde_json::to_string(&journey["positive"]["response"]).unwrap();
    let (base_url, requests) = serve(
        2,
        Arc::new(move |_| {
            if server_counter.fetch_add(1, Ordering::SeqCst) == 0 {
                Response {
                    status: "503 Service Unavailable",
                    content_type: "application/json",
                    headers: vec![("Retry-After", "0")],
                    body: retry_body.clone(),
                }
            } else {
                Response {
                    status: "200 OK",
                    content_type: "application/json",
                    headers: vec![],
                    body: final_body.clone(),
                }
            }
        }),
    );
    let credentials = journey["retry"]["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let credential_attempt = Arc::new(AtomicUsize::new(0));
    let provider_attempt = Arc::clone(&credential_attempt);
    let provider_credentials = credentials.clone();
    let retrying = Client::new(
        ClientOptions::new(&base_url)
            .capability_provider(Arc::new(move || {
                provider_credentials
                    .get(provider_attempt.fetch_add(1, Ordering::SeqCst))
                    .cloned()
            }))
            .retry(RetryPolicy::new(2, Duration::ZERO, Duration::ZERO)),
    )
    .unwrap();
    assert_eq!(
        retrying
            .get_file_metadata_with_capability(&reference)
            .await
            .unwrap()
            .entry_id,
        reference.entry_id,
    );
    let observed = [requests.recv().unwrap(), requests.recv().unwrap()];
    assert_eq!(
        observed[0].headers["authorization"],
        format!("Bearer {}", credentials[0])
    );
    assert_eq!(
        observed[1].headers["authorization"],
        format!("Bearer {}", credentials[1])
    );
    assert_eq!(journey["cleanup"]["applicable"], false);
    assert_eq!(journey["cleanup"]["reason"], "read_only_journey");
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

#[tokio::test]
async fn opt_in_retry_re_resolves_capability_and_replays_safe_request() {
    let transport_calls = Arc::new(AtomicUsize::new(0));
    let transport_counter = Arc::clone(&transport_calls);
    let (base_url, requests) = serve(
        2,
        Arc::new(move |_| {
            if transport_counter.fetch_add(1, Ordering::SeqCst) == 0 {
                return Response {
                    status: "503 Service Unavailable",
                    content_type: "application/json",
                    headers: vec![("Retry-After", "0")],
                    body: format!(
                        r#"{{"code":"ALMIRA_TEMPORARILY_UNAVAILABLE","request_id":"{REQUEST}"}}"#
                    ),
                };
            }
            Response {
                status: "200 OK",
                content_type: "application/json",
                headers: vec![],
                body: file_entry(),
            }
        }),
    );
    let credential_calls = Arc::new(AtomicUsize::new(0));
    let credential_counter = Arc::clone(&credential_calls);
    let client = Client::new(
        ClientOptions::new(base_url)
            .capability_provider(Arc::new(move || {
                let call = credential_counter.fetch_add(1, Ordering::SeqCst) + 1;
                Some(format!("alm_cap_v1.{}{call}", "a".repeat(42)))
            }))
            .retry(RetryPolicy::new(3, Duration::ZERO, Duration::ZERO)),
    )
    .unwrap();
    client
        .get_file_metadata_with_capability(&generation().file)
        .await
        .unwrap();
    let first = requests.recv().unwrap();
    let second = requests.recv().unwrap();
    assert_eq!(transport_calls.load(Ordering::SeqCst), 2);
    assert_eq!(credential_calls.load(Ordering::SeqCst), 2);
    assert_ne!(
        first.headers["authorization"],
        second.headers["authorization"]
    );
    assert_eq!(first.target, second.target);
}

#[tokio::test]
async fn workload_exchange_returns_capability_only_client_and_revokes_exactly() {
    let (base_url, requests) = serve(
        3,
        Arc::new(|request| match request.method.as_str() {
            "POST" => Response {
                status: "201 Created",
                content_type: "application/json",
                headers: vec![],
                body: format!(
                    r#"{{"session_id":"{REQUEST}","token":"{CAPABILITY}","operations":["metadata_read"],"resource":{{"kind":"collection"}},"audience":"https://app.example","policy_revision":1,"issuer_epoch":1,"expires_at":"2026-10-17T12:00:00Z"}}"#
                ),
            },
            "DELETE" => Response {
                status: "200 OK",
                content_type: "application/json",
                headers: vec![],
                body: r#""applied""#.into(),
            },
            _ => Response {
                status: "200 OK",
                content_type: "application/json",
                headers: vec![],
                body: file_entry(),
            },
        }),
    );
    let server = ServerClient::new(ServerClientOptions::new(
        &base_url,
        "workload_session_evidence",
    ))
    .unwrap();
    let request = CreateCapabilitySessionRequest {
        subject: BuilderSubject {
            subject_id: "user_42".into(),
            organization_id: None,
            roles: BTreeSet::new(),
            attributes: BTreeMap::new(),
        },
        operations: vec![ReadAccessOperation::MetadataRead],
        resource: CapabilityResource::Collection,
        audience: "https://app.example".into(),
        lifetime_seconds: 300,
    };
    let session = server
        .create_capability_data_client(
            &collection(),
            &request,
            GENERATION,
            CapabilityDataClientOptions::default(),
        )
        .await
        .unwrap();
    assert!(!format!("{:?}", session.grant).contains(CAPABILITY));
    session
        .data_client
        .get_file_metadata_with_capability(&generation().file)
        .await
        .unwrap();
    assert_eq!(
        server
            .revoke_capability_session(&collection(), REQUEST, GENERATION)
            .await
            .unwrap(),
        "applied"
    );
    let exchange = requests.recv().unwrap();
    let data = requests.recv().unwrap();
    let revoke = requests.recv().unwrap();
    assert_eq!(
        exchange.headers["authorization"],
        "MetamorphWorkload workload_session_evidence"
    );
    assert_eq!(exchange.headers["x-almira-tenant-id"], TENANT);
    assert_eq!(
        data.headers["authorization"],
        format!("Bearer {CAPABILITY}")
    );
    assert_eq!(data.headers["origin"], "https://app.example");
    assert!(!data.headers.contains_key("x-almira-tenant-id"));
    assert_eq!(revoke.method, "DELETE");
    assert_eq!(
        revoke.headers["authorization"],
        "MetamorphWorkload workload_session_evidence"
    );
}

#[tokio::test]
async fn server_upload_create_and_finalize_preserve_descriptor_evidence() {
    let descriptor_id = "018f0000-0000-7000-8000-000000000011";
    let content_sha256 = format!("sha256:{}", "a".repeat(64));
    let descriptor_digest = content_sha256.clone();
    let (base_url, requests) = serve(
        2,
        Arc::new(move |request| {
            if request.target.ends_with("/uploads") {
                return Response {
                    status: "201 Created",
                    content_type: "application/json",
                    headers: vec![],
                    body: format!(
                        r#"{{"transfer_session_id":"{REQUEST}","entry_id":"{ENTRY}","generation_id":"{GENERATION}","descriptor":{{"descriptor_id":"{descriptor_id}","protocol":"single_put","requests":[{{"part_number":1,"offset_bytes":0,"length_bytes":5,"method":"PUT","url":"https://objects.example/one-use-secret","headers":[{{"name":"content-type","value":"text/plain"}}],"one_use":true}}],"expected_size_bytes":5,"content_sha256":"{descriptor_digest}","one_use":true,"expires_at":"2026-10-17T12:00:00Z","part_size_bytes":null,"part_count":1}}}}"#
                    ),
                };
            }
            Response {
                status: "200 OK",
                content_type: "application/json",
                headers: vec![],
                body: format!(
                    r#"{{"entry_id":"{ENTRY}","generation_id":"{GENERATION}","generation_number":1,"state":"available","expected_size_bytes":5,"content_sha256":"{descriptor_digest}","declared_media_type":"text/plain","malware_scan_requirement":"required","safety_state":"clean","revision":1,"created_at":"2026-10-17T12:00:00Z"}}"#
                ),
            }
        }),
    );
    let server = ServerClient::new(ServerClientOptions::new(
        &base_url,
        "workload_session_evidence",
    ))
    .unwrap();
    let created = server
        .create_upload(
            &collection(),
            &CreateUploadRequest {
                path: "avatars/me.txt".into(),
                expected_size_bytes: 5,
                content_sha256: content_sha256.clone(),
                declared_media_type: "text/plain".into(),
                browser_origin: None,
                protocol: None,
            },
            GENERATION,
        )
        .await
        .unwrap();
    assert!(!format!("{:?}", created.descriptor).contains("one-use-secret"));
    let generation = server
        .finalize_upload(
            &collection(),
            &created.transfer_session_id,
            &FinalizeUploadRequest {
                descriptor_id: descriptor_id.into(),
                protocol: "single_put".into(),
                etag: Some("\"etag-one\"".into()),
                provider_version: Some("provider-v1".into()),
                parts: vec![DirectUploadPartCompletion {
                    part_number: 1,
                    etag: "\"etag-one\"".into(),
                }],
                size_bytes: 5,
                content_sha256,
            },
            GENERATION,
        )
        .await
        .unwrap();
    assert_eq!(generation.state, "available");
    let create = requests.recv().unwrap();
    let finalize = requests.recv().unwrap();
    assert!(
        create
            .target
            .ends_with(&format!("/collections/{COLLECTION}/uploads"))
    );
    assert!(
        finalize
            .target
            .ends_with(&format!("/uploads/{REQUEST}/finalize"))
    );
    let completion: Value = serde_json::from_str(&finalize.body).unwrap();
    assert_eq!(completion["descriptor_id"], descriptor_id);
    assert_eq!(completion["etag"], "\"etag-one\"");
    assert_eq!(completion["provider_version"], "provider-v1");
}

#[tokio::test]
async fn workload_subject_bindings_are_namespaced_and_operation_scoped() {
    let binding_id = "018f0000-0000-7000-8000-000000000011";
    let binding = format!(
        r#"{{"binding_id":"{binding_id}","subject":{{"namespace":"auth0:primary","subject_id":"opaque|user-42"}},"environment_id":"{ENVIRONMENT}","collection_instance_id":"{COLLECTION}","entry_id":"{ENTRY}","entry_lifecycle":"active","created_at":"2026-10-17T12:00:00Z"}}"#
    );
    let bind_response = format!(r#"{{"disposition":"applied","binding":{binding}}}"#);
    let list_response = format!(r#"{{"items":[{binding}],"next_cursor":null}}"#);
    let lifecycle = format!(
        r#"{{"operation_id":"{REQUEST}","kind":"delete","state":"pending","subject":{{"namespace":"auth0:primary","subject_id":"opaque|user-42"}},"matched_entries":1,"completed_entries":0,"pending_entries":1,"manifest_digest":"sha256:{}","artifact":null,"created_at":"2026-10-17T12:00:00Z","updated_at":"2026-10-17T12:00:00Z"}}"#,
        "a".repeat(64)
    );
    let (base_url, requests) = serve(
        5,
        Arc::new(move |request| {
            let lifecycle_search = request
                .target
                .ends_with("/subject-lifecycle-operations/search");
            let lifecycle_start = request.target.ends_with("/subject-lifecycle-operations");
            let subject_download = request
                .target
                .ends_with(&format!("/subject-lifecycle-operations/{REQUEST}/download"));
            Response {
                status: if subject_download {
                    "201 Created"
                } else if lifecycle_start {
                    "202 Accepted"
                } else if request.target.ends_with("/subject-bindings") {
                    "201 Created"
                } else {
                    "200 OK"
                },
                content_type: "application/json",
                headers: vec![],
                body: if subject_download {
                    format!(
                        r#"{{"descriptor_id":"{REQUEST}","method":"GET","url":"https://almira.test/v1/subject-export-downloads/{REQUEST}","headers":[{{"name":"authorization","value":"AlmiraTransfer redacted"}}],"expected_size_bytes":3072,"content_sha256":"sha256:{}","one_use":true,"expires_at":"2026-10-17T12:05:00Z"}}"#,
                        "b".repeat(64)
                    )
                } else if lifecycle_search {
                    format!(r#"{{"operation":{lifecycle},"items":[],"next_cursor":null}}"#)
                } else if lifecycle_start {
                    format!(r#"{{"operation":{lifecycle}}}"#)
                } else if request.target.ends_with("/subject-bindings/search") {
                    list_response.clone()
                } else {
                    bind_response.clone()
                },
            }
        }),
    );
    let server = ServerClient::new(ServerClientOptions::new(
        &base_url,
        "workload_session_evidence",
    ))
    .unwrap();
    let subject = SubjectReference {
        namespace: "auth0:primary".into(),
        subject_id: "opaque|user-42".into(),
    };
    let outcome = server
        .bind_subject(
            &FileReference {
                collection: collection(),
                entry_id: ENTRY.into(),
            },
            &subject,
            REQUEST,
        )
        .await
        .unwrap();
    let lifecycle = server
        .start_subject_lifecycle_operation(
            &SubjectProjectReference {
                tenant_id: TENANT.into(),
                project_id: PROJECT.into(),
            },
            &subject,
            "delete",
            REQUEST,
        )
        .await
        .unwrap();
    let manifest = server
        .read_subject_lifecycle_operation(
            &SubjectProjectReference {
                tenant_id: TENANT.into(),
                project_id: PROJECT.into(),
            },
            REQUEST,
            &SubjectBindingPageOptions {
                limit: 25,
                cursor: Some("manifest-next".into()),
            },
        )
        .await
        .unwrap();
    let page = server
        .list_subject_bindings(
            &SubjectProjectReference {
                tenant_id: TENANT.into(),
                project_id: PROJECT.into(),
            },
            &subject,
            &SubjectBindingPageOptions {
                limit: 25,
                cursor: Some("next".into()),
            },
        )
        .await
        .unwrap();
    let descriptor = server
        .create_subject_export_download(
            &SubjectProjectReference {
                tenant_id: TENANT.into(),
                project_id: PROJECT.into(),
            },
            REQUEST,
            &subject,
            REQUEST,
        )
        .await
        .unwrap();
    assert_eq!(outcome.binding.entry_id, ENTRY);
    assert_eq!(page.items.len(), 1);
    assert_eq!(lifecycle.operation.state, "pending");
    assert_eq!(manifest.operation.operation_id, REQUEST);
    assert_eq!(descriptor.expected_size_bytes, 3072);
    assert!(!format!("{descriptor:?}").contains("AlmiraTransfer"));
    assert!(!format!("{subject:?}").contains("opaque|user-42"));

    let bind = requests.recv().unwrap();
    let lifecycle_start = requests.recv().unwrap();
    let lifecycle_read = requests.recv().unwrap();
    let list = requests.recv().unwrap();
    let download = requests.recv().unwrap();
    assert!(bind.target.ends_with(&format!(
        "/collections/{COLLECTION}/files/{ENTRY}/subject-bindings"
    )));
    assert_eq!(
        bind.headers.get("idempotency-key").map(String::as_str),
        Some(REQUEST)
    );
    assert_eq!(
        list.target,
        format!("/v1/projects/{PROJECT}/subject-bindings/search")
    );
    assert!(!list.headers.contains_key("idempotency-key"));
    assert_eq!(
        lifecycle_start
            .headers
            .get("idempotency-key")
            .map(String::as_str),
        Some(REQUEST)
    );
    assert!(!lifecycle_read.headers.contains_key("idempotency-key"));
    assert_eq!(
        download.headers.get("idempotency-key").map(String::as_str),
        Some(REQUEST)
    );
    assert_eq!(
        serde_json::from_str::<Value>(&bind.body).unwrap(),
        serde_json::json!({"namespace": "auth0:primary", "subject_id": "opaque|user-42"})
    );
    assert_eq!(
        serde_json::from_str::<Value>(&list.body).unwrap(),
        serde_json::json!({
            "subject": {"namespace": "auth0:primary", "subject_id": "opaque|user-42"},
            "limit": 25,
            "cursor": "next"
        })
    );
}

struct RecordingDirectTransport {
    bodies: Mutex<Vec<Vec<u8>>>,
}

#[tokio::test]
async fn server_multipart_part_grant_binds_transfer_checksum_and_operation() {
    let content_sha256 = format!("sha256:{}", "d".repeat(64));
    let (base_url, requests) = serve(
        1,
        Arc::new(|_| {
            Response {
            status: "201 Created",
            content_type: "application/json",
            headers: vec![],
            body: r#"{"part_number":2,"offset_bytes":67108864,"length_bytes":1024,"method":"PUT","url":"https://objects.example/one-use-part","headers":[{"name":"x-upload-token","value":"secret"}],"one_use":true}"#.into(),
        }
        }),
    );
    let server = ServerClient::new(ServerClientOptions::new(
        &base_url,
        "workload_session_evidence",
    ))
    .unwrap();
    let part = server
        .create_upload_part(
            &collection(),
            REQUEST,
            &metamorph_almira::CreateMultipartPartGrantRequest {
                part_number: 2,
                content_sha256: content_sha256.clone(),
            },
            GENERATION,
        )
        .await
        .unwrap();
    assert_eq!(part.part_number, 2);
    let request = requests.recv().unwrap();
    assert!(
        request
            .target
            .ends_with(&format!("/uploads/{REQUEST}/parts"))
    );
    assert_eq!(
        request.headers.get("idempotency-key"),
        Some(&GENERATION.into())
    );
    assert_eq!(
        serde_json::from_str::<Value>(&request.body).unwrap(),
        serde_json::json!({"part_number": 2, "content_sha256": content_sha256})
    );
}

impl DirectUploadTransport for RecordingDirectTransport {
    #[allow(clippy::manual_async_fn)] // Match the SDK trait's explicit Send future.
    fn put<'a>(
        &'a self,
        part: &'a DirectUploadPart,
        source_path: &'a Path,
    ) -> impl std::future::Future<Output = Result<DirectUploadResponse, TransferError>> + Send + 'a
    {
        async move {
            let mut file = std::fs::File::open(source_path).unwrap();
            file.seek(std::io::SeekFrom::Start(part.offset_bytes))
                .unwrap();
            let mut body = Vec::new();
            file.take(part.length_bytes).read_to_end(&mut body).unwrap();
            self.bodies.lock().unwrap().push(body);
            Ok(DirectUploadResponse {
                status: 200,
                etag: Some(format!("\"part-{}\"", part.part_number)),
                provider_versions: vec![],
            })
        }
    }
}

#[tokio::test]
async fn direct_upload_streams_exact_file_parts_without_almira_credentials() {
    let path = std::env::temp_dir().join(format!(
        "almira-rust-direct-upload-{}-{}",
        std::process::id(),
        REQUEST
    ));
    std::fs::write(&path, b"hello").unwrap();
    let descriptor = DirectUploadDescriptor {
        descriptor_id: "018f0000-0000-7000-8000-000000000011".into(),
        protocol: "multipart".into(),
        requests: vec![],
        expected_size_bytes: 5,
        content_sha256: format!("sha256:{}", "a".repeat(64)),
        one_use: true,
        expires_at: "2026-10-17T12:00:00Z".into(),
        part_size_bytes: Some(2),
        part_count: 3,
    };
    let transport = RecordingDirectTransport {
        bodies: Mutex::new(vec![]),
    };
    let grants = Mutex::new(Vec::new());
    let grant_part = |request: metamorph_almira::CreateMultipartPartGrantRequest| {
        grants.lock().unwrap().push(request.clone());
        async move {
            let offset = u64::from(request.part_number - 1) * 2;
            Ok(DirectUploadPart {
                part_number: request.part_number,
                offset_bytes: offset,
                length_bytes: 2_u64.min(5 - offset),
                method: "PUT".into(),
                url: format!("https://objects.example/secret-{}", request.part_number),
                headers: vec![DirectUploadHeader {
                    name: "content-type".into(),
                    value: "text/plain".into(),
                }],
                one_use: true,
            })
        }
    };
    let completion = upload_direct_file_with(&descriptor, &path, &transport, &grant_part, || {
        OffsetDateTime::parse(
            "2026-10-17T10:00:00Z",
            &time::format_description::well_known::Rfc3339,
        )
        .unwrap()
    })
    .await
    .unwrap();
    std::fs::remove_file(&path).unwrap();
    assert_eq!(
        *transport.bodies.lock().unwrap(),
        vec![b"he".to_vec(), b"ll".to_vec(), b"o".to_vec()]
    );
    assert_eq!(grants.lock().unwrap().len(), 3);
    assert_eq!(
        grants.lock().unwrap()[0].content_sha256,
        "sha256:372f7e2fd2d01ce2a1d71dc072acbba4c6fd25a1087cd7f153f4ec0ce37e1ede"
    );
    assert_eq!(completion.protocol, "multipart");
    assert!(completion.etag.is_none());
    assert!(completion.provider_version.is_none());
    assert_eq!(completion.parts.len(), 3);
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
