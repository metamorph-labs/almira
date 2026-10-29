import 'package:flutter/material.dart';
import 'package:metamorph_almira/almira.dart';

void main() => runApp(const AlmiraExample());

class AlmiraExample extends StatelessWidget {
  const AlmiraExample({super.key});
  @override
  Widget build(BuildContext context) => const MaterialApp(home: FilePage());
}

class FilePage extends StatefulWidget {
  const FilePage({super.key});
  @override
  State<FilePage> createState() => _FilePageState();
}

class _FilePageState extends State<FilePage> {
  String state = 'Loading…';

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    try {
      final client = AlmiraDataClient(
          baseUrl: required('ALMIRA_BASE_URL'),
          capability: () => required('ALMIRA_CAPABILITY'),
          retry: const RetryPolicy(
              maxAttempts: 3,
              baseDelay: Duration(milliseconds: 100),
              maximumDelay: Duration(seconds: 2)));
      final entry = await client.getFileMetadataWithCapability(FileReference(
          tenantId: required('ALMIRA_TENANT_ID'),
          projectId: required('ALMIRA_PROJECT_ID'),
          environmentId: required('ALMIRA_ENVIRONMENT_ID'),
          collectionInstanceId: required('ALMIRA_COLLECTION_ID'),
          entryId: required('ALMIRA_ENTRY_ID'))) as Map<String, Object?>;
      if (mounted) setState(() => state = '${entry['logical_path']} — ${entry['lifecycle']}');
    } catch (error) {
      if (mounted) setState(() => state = 'Read refused: $error');
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
      appBar: AppBar(title: const Text('Almira managed-development read')),
      body: Center(child: Text(state)),
      floatingActionButton: FloatingActionButton(onPressed: load, child: const Icon(Icons.refresh)));
}

String required(String name) {
  const values = {
    'ALMIRA_BASE_URL': String.fromEnvironment('ALMIRA_BASE_URL'),
    'ALMIRA_CAPABILITY': String.fromEnvironment('ALMIRA_CAPABILITY'),
    'ALMIRA_TENANT_ID': String.fromEnvironment('ALMIRA_TENANT_ID'),
    'ALMIRA_PROJECT_ID': String.fromEnvironment('ALMIRA_PROJECT_ID'),
    'ALMIRA_ENVIRONMENT_ID': String.fromEnvironment('ALMIRA_ENVIRONMENT_ID'),
    'ALMIRA_COLLECTION_ID': String.fromEnvironment('ALMIRA_COLLECTION_ID'),
    'ALMIRA_ENTRY_ID': String.fromEnvironment('ALMIRA_ENTRY_ID'),
  };
  final value = values[name] ?? '';
  if (value.isEmpty) throw StateError('$name is required');
  return value;
}
