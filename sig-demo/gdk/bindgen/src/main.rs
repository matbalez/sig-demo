// Copyright 2026 sig demo contributors
// SPDX-License-Identifier: AGPL-3.0-only

//! Extract the SDK's real UniFFI metadata rather than duplicate its C ABI.
use anyhow::{Context, Result};
use camino::Utf8Path;
use serde_json::{json, Value};
use uniffi_bindgen::{
    interface::{AsType, DefaultValue, FfiFunction, FfiType, Field, Literal, Type},
    library_mode::find_components,
    EmptyCrateConfigSupplier,
};

fn ty(value: &Type) -> Value {
    match value {
        Type::Optional { inner_type } => json!({"kind":"optional","inner":ty(inner_type)}),
        Type::Sequence { inner_type } => json!({"kind":"sequence","inner":ty(inner_type)}),
        Type::Set { inner_type } => json!({"kind":"set","inner":ty(inner_type)}),
        Type::Map {
            key_type,
            value_type,
        } => json!({"kind":"map","key":ty(key_type),"value":ty(value_type)}),
        Type::Box { inner_type } => ty(inner_type),
        Type::Custom { builtin, .. } => ty(builtin),
        Type::Record { name, .. } => json!({"kind":"record","name":name}),
        Type::Enum { name, .. } => json!({"kind":"enum","name":name}),
        Type::Object { name, .. } => json!({"kind":"object","name":name}),
        Type::CallbackInterface { name, .. } => json!({"kind":"callback","name":name}),
        other => json!({"kind":format!("{other:?}").to_ascii_lowercase()}),
    }
}

fn default(value: &DefaultValue) -> Value {
    match value {
        DefaultValue::Default | DefaultValue::Literal(Literal::None) => Value::Null,
        DefaultValue::Literal(Literal::Boolean(value)) => json!(value),
        DefaultValue::Literal(Literal::String(value)) => json!(value),
        DefaultValue::Literal(Literal::UInt(value, _, _)) => json!(value),
        DefaultValue::Literal(Literal::Int(value, _, _)) => json!(value),
        DefaultValue::Literal(Literal::Float(value, _)) => json!(value.parse::<f64>().unwrap()),
        DefaultValue::Literal(Literal::Enum(value, _)) => json!(value),
        DefaultValue::Literal(Literal::EmptySequence | Literal::EmptySet) => json!([]),
        DefaultValue::Literal(Literal::EmptyMap) => json!({}),
        DefaultValue::Literal(Literal::Some { inner }) => default(inner),
    }
}

fn field(value: &Field) -> Value {
    let mut result = json!({"name":value.name(),"type":ty(&value.as_type())});
    if let Some(value) = value.default_value() {
        result["default"] = default(value);
    }
    result
}

fn ffi_type(value: &FfiType) -> String {
    match value {
        FfiType::RustBuffer(_) => "rust_buffer".to_owned(),
        FfiType::Handle => "uint64".to_owned(),
        other => format!("{other:?}").to_ascii_lowercase(),
    }
}

fn ffi(value: &FfiFunction) -> Value {
    json!({
        "symbol":value.name(),
        "arguments":value.arguments().iter().map(|arg|ffi_type(&arg.type_())).collect::<Vec<_>>(),
        "return":value.return_type().map(ffi_type).unwrap_or_else(||"void".to_owned()),
        "status":value.has_rust_call_status_arg(),
    })
}

fn return_flavor(value: Option<&Type>) -> String {
    FfiType::return_type_name(value.map(FfiType::from).as_ref())
}

fn main() -> Result<()> {
    let arguments = std::env::args().collect::<Vec<_>>();
    let library = arguments.get(1).context("Provide the SDK cdylib path")?;
    let output = arguments.get(2).context("Provide the schema output path")?;
    let namespace = arguments.get(3).map(String::as_str).unwrap_or("goose");
    let components = find_components(Utf8Path::new(library), &EmptyCrateConfigSupplier)?;
    let mut ci = components
        .iter()
        .find(|component| component.ci.namespace() == namespace)
        .with_context(|| format!("The library does not contain the {namespace} UniFFI namespace"))?
        .ci
        .clone();
    ci.derive_ffi_funcs()?;
    let records = ci
        .record_definitions()
        .iter()
        .map(|record| {
            json!({
                "name":record.name(),"fields":record.fields().iter().map(field).collect::<Vec<_>>()
            })
        })
        .collect::<Vec<_>>();
    let enums = ci.enum_definitions().iter().map(|enumeration|json!({
        "name":enumeration.name(),"flat":enumeration.is_flat(),
        "variants":enumeration.variants().iter().map(|variant|json!({
            "name":variant.name(),"fields":variant.fields().iter().map(field).collect::<Vec<_>>()
        })).collect::<Vec<_>>()
    })).collect::<Vec<_>>();
    let functions = ci.function_definitions().iter().map(|function|json!({
        "name":function.name(),"async":function.is_async(),"ffi":ffi(function.ffi_func()),
        "arguments":function.arguments().iter().map(|arg|json!({"name":arg.name(),"type":ty(&arg.as_type())})).collect::<Vec<_>>(),
        "return":function.return_type().map(ty),"futureFlavor":return_flavor(function.return_type()),
        "error":function.throws_name(),
    })).collect::<Vec<_>>();
    let objects = ci.object_definitions().iter().map(|object|json!({
        "name":object.name(),"clone":ffi(object.ffi_object_clone()),"free":ffi(object.ffi_object_free()),
        "methods":object.methods().iter().map(|method|json!({
            "name":method.name(),"async":method.is_async(),"ffi":ffi(method.ffi_func()),
            "arguments":method.arguments().iter().map(|arg|json!({"name":arg.name(),"type":ty(&arg.as_type())})).collect::<Vec<_>>(),
            "return":method.return_type().map(ty),"futureFlavor":return_flavor(method.return_type()),"error":method.throws_name(),
        })).collect::<Vec<_>>()
    })).collect::<Vec<_>>();
    let mut futures = serde_json::Map::new();
    for (flavor, return_type) in [
        ("u64", Some(FfiType::UInt64)),
        ("rust_buffer", Some(FfiType::RustBuffer(None))),
        ("void", None),
    ] {
        futures.insert(
            flavor.to_owned(),
            json!({
                "poll":ci.ffi_rust_future_poll(return_type.clone()).name(),
                "complete":ffi(&ci.ffi_rust_future_complete(return_type.clone())),
                "cancel":ci.ffi_rust_future_cancel(return_type.clone()).name(),
                "free":ci.ffi_rust_future_free(return_type).name(),
            }),
        );
    }
    let result = json!({
        "sdkVersion":"0.1.0-alpha.12","uniffiVersion":"0.32.2","namespace":ci.namespace(),
        "contractVersion":ci.uniffi_contract_version(),"contractSymbol":ci.ffi_uniffi_contract_version().name(),
        "checksums":ci.iter_checksums().map(|(symbol,value)|json!({"symbol":symbol,"value":value})).collect::<Vec<_>>(),
        "buffers":{"allocate":ffi(&ci.ffi_rustbuffer_alloc()),"fromBytes":ffi(&ci.ffi_rustbuffer_from_bytes()),"free":ffi(&ci.ffi_rustbuffer_free())},
        "futures":futures,"records":records,"enums":enums,"functions":functions,"objects":objects,
    });
    std::fs::write(output, serde_json::to_string_pretty(&result)? + "\n")?;
    println!(
        "Extracted {namespace} UniFFI metadata: {} records, {} enums, {} objects",
        ci.record_definitions().len(),
        ci.enum_definitions().len(),
        ci.object_definitions().len()
    );
    Ok(())
}
