package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestEmbeddedIdentityNamesTheApp(t *testing.T) {
	var raw map[string]any
	if err := json.Unmarshal(identityJSON, &raw); err != nil {
		t.Fatalf("identity.json does not parse: %v", err)
	}
	for field, value := range map[string]string{
		"bundleId":    product.BundleID,
		"productName": product.ProductName,
		"packageName": product.PackageName,
		"binaryName":  product.BinaryName,
	} {
		if value == "" || value != raw[field] {
			t.Errorf("%s: read %q, the file holds %v", field, value, raw[field])
		}
	}
	if strings.ContainsAny(product.BinaryName, `/\.`) {
		t.Errorf("binaryName is a bare file name without extension: %q", product.BinaryName)
	}
}

func TestIdentityWithAMissingNameIsRefused(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("an identity without a bundle id was accepted")
		}
	}()
	parseIdentity([]byte(`{"productName":"A","packageName":"a","binaryName":"a"}`))
}
