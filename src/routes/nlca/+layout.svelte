<script lang="ts">
	import MainAppNlca from '$lib/components/MainAppNlca.svelte';

	let { children } = $props();
</script>

<MainAppNlca />
{@render children()}
