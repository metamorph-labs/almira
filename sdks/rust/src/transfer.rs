use crate::server::{
    CreateMultipartPartGrantRequest, DirectUploadDescriptor, DirectUploadPart,
    DirectUploadPartCompletion, FinalizeUploadRequest, valid_direct_upload_descriptor,
    valid_direct_upload_part, valid_provider_receipt, valid_provider_version,
};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use sha2::{Digest, Sha256};
use std::future::Future;
use std::path::Path;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransferError {
    pub code: &'static str,
    pub part_number: Option<u16>,
    pub status: Option<u16>,
}

impl std::fmt::Display for TransferError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for TransferError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectUploadResponse {
    pub status: u16,
    pub etag: Option<String>,
    pub provider_versions: Vec<String>,
}

pub trait DirectUploadTransport: Send + Sync {
    fn put<'a>(
        &'a self,
        part: &'a DirectUploadPart,
        source_path: &'a Path,
    ) -> impl Future<Output = Result<DirectUploadResponse, TransferError>> + Send + 'a;
}

pub trait DirectUploadPartGrant: Send + Sync {
    fn grant(
        &self,
        request: CreateMultipartPartGrantRequest,
    ) -> impl Future<Output = Result<DirectUploadPart, TransferError>> + Send;
}

impl<F, Output> DirectUploadPartGrant for F
where
    F: Fn(CreateMultipartPartGrantRequest) -> Output + Send + Sync,
    Output: Future<Output = Result<DirectUploadPart, TransferError>> + Send,
{
    fn grant(
        &self,
        request: CreateMultipartPartGrantRequest,
    ) -> impl Future<Output = Result<DirectUploadPart, TransferError>> + Send {
        self(request)
    }
}

#[derive(Clone)]
pub struct ReqwestDirectUploadTransport {
    http: reqwest::Client,
}

impl ReqwestDirectUploadTransport {
    pub fn new() -> Result<Self, TransferError> {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| transfer_error("ALMIRA_TRANSFER_DESCRIPTOR_INVALID", None, None))?;
        Ok(Self { http })
    }
}

impl DirectUploadTransport for ReqwestDirectUploadTransport {
    #[allow(clippy::manual_async_fn)] // Keep the explicit Send future promised by the public trait.
    fn put<'a>(
        &'a self,
        part: &'a DirectUploadPart,
        source_path: &'a Path,
    ) -> impl Future<Output = Result<DirectUploadResponse, TransferError>> + Send + 'a {
        async move {
            let mut file = tokio::fs::File::open(source_path).await.map_err(|_| {
                transfer_error(
                    "ALMIRA_TRANSFER_SOURCE_UNAVAILABLE",
                    Some(part.part_number),
                    None,
                )
            })?;
            file.seek(std::io::SeekFrom::Start(part.offset_bytes))
                .await
                .map_err(|_| {
                    transfer_error(
                        "ALMIRA_TRANSFER_SOURCE_UNAVAILABLE",
                        Some(part.part_number),
                        None,
                    )
                })?;
            let stream = ReaderStream::new(file.take(part.length_bytes));
            let mut headers = HeaderMap::new();
            for header in &part.headers {
                headers.insert(
                    HeaderName::from_bytes(header.name.as_bytes()).map_err(|_| {
                        transfer_error(
                            "ALMIRA_TRANSFER_DESCRIPTOR_INVALID",
                            Some(part.part_number),
                            None,
                        )
                    })?,
                    HeaderValue::from_str(&header.value).map_err(|_| {
                        transfer_error(
                            "ALMIRA_TRANSFER_DESCRIPTOR_INVALID",
                            Some(part.part_number),
                            None,
                        )
                    })?,
                );
            }
            let response = self
                .http
                .put(&part.url)
                .headers(headers)
                .header(reqwest::header::CONTENT_LENGTH, part.length_bytes)
                .body(reqwest::Body::wrap_stream(stream))
                .send()
                .await
                .map_err(|_| {
                    transfer_error(
                        "ALMIRA_TRANSFER_OUTCOME_UNKNOWN",
                        Some(part.part_number),
                        None,
                    )
                })?;
            let status = response.status().as_u16();
            let etag = response
                .headers()
                .get(reqwest::header::ETAG)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let provider_versions = ["x-amz-version-id", "x-goog-generation", "x-ms-version-id"]
                .into_iter()
                .filter_map(|name| {
                    response
                        .headers()
                        .get(name)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned)
                })
                .collect();
            drop(response);
            Ok(DirectUploadResponse {
                status,
                etag,
                provider_versions,
            })
        }
    }
}

pub async fn upload_direct_file(
    descriptor: &DirectUploadDescriptor,
    source_path: impl AsRef<Path>,
) -> Result<FinalizeUploadRequest, TransferError> {
    let transport = ReqwestDirectUploadTransport::new()?;
    upload_direct_file_with(
        descriptor,
        source_path.as_ref(),
        &transport,
        &|_| async {
            Err(transfer_error(
                "ALMIRA_TRANSFER_DESCRIPTOR_INVALID",
                None,
                None,
            ))
        },
        OffsetDateTime::now_utc,
    )
    .await
}

pub async fn upload_direct_file_with<T, G, C>(
    descriptor: &DirectUploadDescriptor,
    source_path: &Path,
    transport: &T,
    grant_part: &G,
    clock: C,
) -> Result<FinalizeUploadRequest, TransferError>
where
    T: DirectUploadTransport,
    G: DirectUploadPartGrant,
    C: Fn() -> OffsetDateTime,
{
    if !valid_direct_upload_descriptor(descriptor) {
        return Err(transfer_error(
            "ALMIRA_TRANSFER_DESCRIPTOR_INVALID",
            None,
            None,
        ));
    }
    let size = tokio::fs::metadata(source_path)
        .await
        .map_err(|_| transfer_error("ALMIRA_TRANSFER_SOURCE_UNAVAILABLE", None, None))?
        .len();
    if size != descriptor.expected_size_bytes {
        return Err(transfer_error(
            "ALMIRA_TRANSFER_DESCRIPTOR_INVALID",
            None,
            None,
        ));
    }
    let mut completions = Vec::with_capacity(usize::from(descriptor.part_count));
    let mut object_etag = None;
    let mut provider_version = None;
    for part_number in 1..=descriptor.part_count {
        require_unexpired(descriptor, clock())?;
        let expected = expected_part(descriptor, part_number);
        let part = if descriptor.protocol == "single_put" {
            descriptor.requests[0].clone()
        } else {
            let digest = part_sha256(source_path, &expected).await?;
            let part = grant_part
                .grant(CreateMultipartPartGrantRequest {
                    part_number,
                    content_sha256: digest,
                })
                .await?;
            if !valid_direct_upload_part(&part)
                || part.part_number != expected.part_number
                || part.offset_bytes != expected.offset_bytes
                || part.length_bytes != expected.length_bytes
            {
                return Err(transfer_error(
                    "ALMIRA_TRANSFER_DESCRIPTOR_INVALID",
                    Some(part_number),
                    None,
                ));
            }
            require_unexpired(descriptor, clock())?;
            part
        };
        let response = transport.put(&part, source_path).await?;
        if !(100..=599).contains(&response.status) {
            return Err(transfer_error(
                "ALMIRA_TRANSFER_RESPONSE_INVALID",
                Some(part.part_number),
                None,
            ));
        }
        if !(200..300).contains(&response.status) {
            return Err(transfer_error(
                "ALMIRA_TRANSFER_PART_REFUSED",
                Some(part.part_number),
                Some(response.status),
            ));
        }
        let etag = response
            .etag
            .filter(|value| valid_provider_receipt(value))
            .ok_or_else(|| {
                transfer_error(
                    "ALMIRA_TRANSFER_RESPONSE_INVALID",
                    Some(part.part_number),
                    None,
                )
            })?;
        if descriptor.protocol == "single_put" {
            if response
                .provider_versions
                .iter()
                .any(|value| !valid_provider_version(value))
                || response
                    .provider_versions
                    .windows(2)
                    .any(|pair| pair[0] != pair[1])
            {
                return Err(transfer_error(
                    "ALMIRA_TRANSFER_RESPONSE_INVALID",
                    Some(part.part_number),
                    None,
                ));
            }
            object_etag = Some(etag.clone());
            provider_version = response.provider_versions.first().cloned();
        }
        completions.push(DirectUploadPartCompletion {
            part_number: part.part_number,
            etag,
        });
    }
    Ok(FinalizeUploadRequest {
        descriptor_id: descriptor.descriptor_id.clone(),
        protocol: descriptor.protocol.clone(),
        etag: object_etag,
        provider_version,
        parts: completions,
        size_bytes: size,
        content_sha256: descriptor.content_sha256.clone(),
    })
}

fn expected_part(descriptor: &DirectUploadDescriptor, part_number: u16) -> DirectUploadPart {
    if descriptor.protocol == "single_put" {
        return descriptor.requests[0].clone();
    }
    let part_size = descriptor
        .part_size_bytes
        .expect("validated multipart geometry");
    let offset = u64::from(part_number - 1) * part_size;
    DirectUploadPart {
        part_number,
        offset_bytes: offset,
        length_bytes: part_size.min(descriptor.expected_size_bytes - offset),
        method: "PUT".into(),
        url: String::new(),
        headers: vec![],
        one_use: true,
    }
}

async fn part_sha256(source_path: &Path, part: &DirectUploadPart) -> Result<String, TransferError> {
    let mut file = tokio::fs::File::open(source_path).await.map_err(|_| {
        transfer_error(
            "ALMIRA_TRANSFER_SOURCE_UNAVAILABLE",
            Some(part.part_number),
            None,
        )
    })?;
    file.seek(std::io::SeekFrom::Start(part.offset_bytes))
        .await
        .map_err(|_| {
            transfer_error(
                "ALMIRA_TRANSFER_SOURCE_UNAVAILABLE",
                Some(part.part_number),
                None,
            )
        })?;
    let mut remaining = part.length_bytes;
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut digest = Sha256::new();
    while remaining > 0 {
        let limit = usize::try_from(remaining.min(buffer.len() as u64)).unwrap_or(buffer.len());
        let read = file.read(&mut buffer[..limit]).await.map_err(|_| {
            transfer_error(
                "ALMIRA_TRANSFER_SOURCE_UNAVAILABLE",
                Some(part.part_number),
                None,
            )
        })?;
        if read == 0 {
            return Err(transfer_error(
                "ALMIRA_TRANSFER_DESCRIPTOR_INVALID",
                Some(part.part_number),
                None,
            ));
        }
        digest.update(&buffer[..read]);
        remaining -= u64::try_from(read).unwrap_or(remaining);
    }
    Ok(format!("sha256:{:x}", digest.finalize()))
}

fn require_unexpired(
    descriptor: &DirectUploadDescriptor,
    now: OffsetDateTime,
) -> Result<(), TransferError> {
    let expires_at = OffsetDateTime::parse(&descriptor.expires_at, &Rfc3339)
        .map_err(|_| transfer_error("ALMIRA_TRANSFER_DESCRIPTOR_INVALID", None, None))?;
    if expires_at <= now {
        return Err(transfer_error(
            "ALMIRA_TRANSFER_DESCRIPTOR_EXPIRED",
            None,
            None,
        ));
    }
    Ok(())
}

fn transfer_error(
    code: &'static str,
    part_number: Option<u16>,
    status: Option<u16>,
) -> TransferError {
    TransferError {
        code,
        part_number,
        status,
    }
}
