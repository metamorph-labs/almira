package almira

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"
)

type TransferError struct {
	Code       string
	PartNumber int
	StatusCode int
}

func (error *TransferError) Error() string { return error.Code }

type DirectUploadOptions struct {
	Transport http.RoundTripper
	Now       func() time.Time
}

// UploadDirect streams exact one-use descriptor slices and returns finalize evidence.
func UploadDirect(
	ctx context.Context,
	descriptor DirectUploadDescriptor,
	body io.ReaderAt,
	sizeBytes int64,
	options DirectUploadOptions,
) (FinalizeUploadRequest, error) {
	var zero FinalizeUploadRequest
	if ctx == nil || body == nil || sizeBytes != descriptor.ExpectedSizeBytes || !validDirectUploadDescriptor(descriptor) {
		return zero, transferFailure("ALMIRA_TRANSFER_DESCRIPTOR_INVALID", 0, 0)
	}
	transport := options.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	client := &http.Client{
		Transport:     transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	parts := make([]DirectUploadPartCompletion, 0, len(descriptor.Requests))
	var objectETag, providerVersion *string
	for _, part := range descriptor.Requests {
		if err := requireUnexpired(descriptor, now()); err != nil {
			return zero, err
		}
		request, err := http.NewRequestWithContext(
			ctx,
			http.MethodPut,
			part.URL,
			io.NewSectionReader(body, part.OffsetBytes, part.LengthBytes),
		)
		if err != nil {
			return zero, transferFailure("ALMIRA_TRANSFER_DESCRIPTOR_INVALID", part.PartNumber, 0)
		}
		request.ContentLength = part.LengthBytes
		for _, header := range part.Headers {
			request.Header.Set(header.Name, header.Value)
		}
		response, err := client.Do(request)
		if err != nil {
			return zero, transferFailure("ALMIRA_TRANSFER_OUTCOME_UNKNOWN", part.PartNumber, 0)
		}
		if response == nil || response.Body == nil || response.StatusCode < 100 || response.StatusCode > 599 {
			if response != nil && response.Body != nil {
				response.Body.Close()
			}
			return zero, transferFailure("ALMIRA_TRANSFER_RESPONSE_INVALID", part.PartNumber, 0)
		}
		response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return zero, transferFailure("ALMIRA_TRANSFER_PART_REFUSED", part.PartNumber, response.StatusCode)
		}
		etag := response.Header.Get("ETag")
		if !validProviderReceipt(etag) {
			return zero, transferFailure("ALMIRA_TRANSFER_RESPONSE_INVALID", part.PartNumber, 0)
		}
		if descriptor.Protocol == "single_put" {
			versions := make([]string, 0, 3)
			for _, name := range []string{"X-Amz-Version-Id", "X-Goog-Generation", "X-Ms-Version-Id"} {
				if value := response.Header.Get(name); value != "" {
					versions = append(versions, value)
				}
			}
			if len(versions) > 0 {
				for _, value := range versions {
					if !validProviderVersion(value) || value != versions[0] {
						return zero, transferFailure("ALMIRA_TRANSFER_RESPONSE_INVALID", part.PartNumber, 0)
					}
				}
				value := versions[0]
				providerVersion = &value
			}
			value := etag
			objectETag = &value
		}
		parts = append(parts, DirectUploadPartCompletion{PartNumber: part.PartNumber, ETag: etag})
	}
	return FinalizeUploadRequest{
		DescriptorID: descriptor.DescriptorID, Protocol: descriptor.Protocol,
		ETag: objectETag, ProviderVersion: providerVersion, Parts: parts,
		SizeBytes: sizeBytes, ContentSHA256: descriptor.ContentSHA256,
	}, nil
}

func requireUnexpired(descriptor DirectUploadDescriptor, now time.Time) error {
	expiresAt, err := time.Parse(time.RFC3339Nano, descriptor.ExpiresAt)
	if err != nil || now.IsZero() {
		return transferFailure("ALMIRA_TRANSFER_DESCRIPTOR_INVALID", 0, 0)
	}
	if !expiresAt.After(now) {
		return transferFailure("ALMIRA_TRANSFER_DESCRIPTOR_EXPIRED", 0, 0)
	}
	return nil
}

func transferFailure(code string, partNumber, statusCode int) error {
	return &TransferError{Code: code, PartNumber: partNumber, StatusCode: statusCode}
}

func (error TransferError) String() string {
	return fmt.Sprintf("TransferError{Code:%s, PartNumber:%d, StatusCode:%d}", error.Code, error.PartNumber, error.StatusCode)
}

func (error TransferError) GoString() string { return error.String() }
